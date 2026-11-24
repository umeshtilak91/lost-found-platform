"use strict";

// Item-return lifecycle.
//
//   OPEN ──accept──▶ RETURN BEING ARRANGED ──finder: handover──▶ AWAITING OWNER CONFIRMATION
//     │                    │  └────────────owner: received───────────────┐       │
//     │                    │                                             ▼       ▼ owner: received
//     │                    ├─ owner: "found it myself" / finder: "returned outside" ─▶ CLOSED (+reason)
//     │                    └─ poster cancels match ─▶ OPEN                      RETURNED
//     └─ "found it myself" / "returned outside" / close ─▶ CLOSED (+reason)
//
// Rules
// - Only the match's owner confirms receipt; only its finder reports handover
//   and reward receipt. Everything is authorised on the server.
// - Every transition locks the listing rows (in id order) and then the claim
//   row, so concurrent requests serialise and repeated requests are no-ops.
// - A completed return creates exactly one live row in `recoveries`, linking
//   both listings when the claimant linked their own listing; partial unique
//   indexes make double counting impossible.
// - Time never confirms a receipt: reminders only.
// - Closing a listing never touches money. Paid connections stay recorded and
//   the existing refund request/support path remains available.
// - Notifications are written inside the same transaction (dedupe keys make
//   them idempotent) and delivered by email only after commit.

const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");

const REMINDERS = [
  { n: 1, after: "48 hours" },
  { n: 2, after: "7 days" },
];

function returnState(claim) {
  if (!claim || claim.status !== "accepted") return null;
  if (claim.return_confirmed_at) return "returned";
  if (claim.handover_at) return "awaiting_owner";
  return claim.unlocked_at ? "arranging" : "awaiting_connection";
}

function createReturnService({ pool, notifier, logger }) {
  async function event(db, { event: name, claimId = null, itemId = null, recoveryId = null, actorId = null, note = null }) {
    await db.query("INSERT INTO return_events (event, claim_id, item_id, recovery_id, actor_id, note) VALUES ($1, $2, $3, $4, $5, $6)", [
      name,
      claimId,
      itemId,
      recoveryId,
      actorId,
      note,
    ]);
  }

  // Locks the claim's listing(s) in id order, then the claim.
  async function lockMatch(db, claimId) {
    const pre = await db.query("SELECT item_id, linked_item_id FROM claims WHERE id = $1", [claimId]);
    if (!pre.rows[0]) throw new HttpError(404, "Match not found", "claim_not_found");
    const ids = [pre.rows[0].item_id, pre.rows[0].linked_item_id].filter(Boolean);
    const items = (await db.query("SELECT * FROM items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids])).rows;
    const { rows } = await db.query(
      `SELECT c.*, conv.id AS conversation_id, conv.unlocked_at FROM claims c
       LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [claimId]
    );
    const claim = rows[0];
    return { claim, item: items.find((i) => i.id === claim.item_id) || null, linked: items.find((i) => i.id === claim.linked_item_id) || null };
  }

  // Locks a listing plus every listing tied to it through an accepted match
  // (as the claimed item or as the claimant's linked listing), then those claims.
  async function lockListing(db, itemId) {
    const related = await db.query(
      `SELECT id, item_id, linked_item_id FROM claims WHERE status = 'accepted' AND (item_id = $1 OR linked_item_id = $1)`,
      [itemId]
    );
    const ids = new Set([itemId]);
    for (const r of related.rows) [r.item_id, r.linked_item_id].filter(Boolean).forEach((id) => ids.add(id));
    const items = (await db.query("SELECT * FROM items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [[...ids]])).rows;
    const claims = (
      await db.query(
        `SELECT c.*, conv.id AS conversation_id, conv.unlocked_at FROM claims c
         LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
         WHERE c.status = 'accepted' AND (c.item_id = $1 OR c.linked_item_id = $1)
         ORDER BY c.id FOR UPDATE OF c`,
        [itemId]
      )
    ).rows;
    return { item: items.find((i) => i.id === itemId) || null, items, claims };
  }

  function requireParticipant(claim, user) {
    if (!claim || (claim.owner_id !== user.id && claim.finder_id !== user.id)) throw new HttpError(404, "Match not found", "claim_not_found");
  }

  // Closes other pending claims on a listing with a reason the claimant sees.
  async function supersedePending(db, itemId, reason, notifications) {
    const { rows } = await db.query(
      `UPDATE claims SET status = 'superseded', close_reason = $2, decided_at = now(), updated_at = now()
       WHERE item_id = $1 AND status = 'pending' RETURNING id, claimant_id`,
      [itemId, reason]
    );
    for (const c of rows) {
      notifications.push(
        await notifier.notify(db, {
          userId: c.claimant_id,
          type: "claim_update",
          itemId,
          data: { claimId: Number(c.id), status: "superseded", reason },
          dedupeKey: `claim:${c.id}:superseded`,
        })
      );
    }
    return rows.length;
  }

  // ---------------------------------------------------------------------
  // Finder: "I handed over this item"
  // ---------------------------------------------------------------------
  async function reportHandover(user, claimId) {
    const result = await withTransaction(pool, async (db) => {
      const { claim } = await lockMatch(db, claimId);
      requireParticipant(claim, user);
      if (claim.finder_id !== user.id) throw new HttpError(403, "Only the finder reports the handover", "not_finder");
      if (claim.status !== "accepted") throw new HttpError(409, "This match is not active", "match_not_accepted");
      // Owner already confirmed: the return is complete; keep it that way.
      if (claim.return_confirmed_at) return { changed: false, notifications: [] };
      if (!claim.unlocked_at) throw new HttpError(402, "Connect first: the ₹100 connection fee unlocks this match", "connection_locked");
      if (claim.handover_at) return { changed: false, notifications: [] };
      await db.query("UPDATE claims SET handover_at = now(), handover_by = $2, updated_at = now() WHERE id = $1", [claimId, user.id]);
      await event(db, { event: "handover_reported", claimId, itemId: claim.item_id, actorId: user.id });
      const note = await notifier.notify(db, {
        userId: claim.owner_id,
        type: "handover_reported",
        itemId: claim.item_id,
        data: { claimId: Number(claimId), conversationId: claim.conversation_id ? Number(claim.conversation_id) : null },
        dedupeKey: `claim:${claimId}:handover`,
      });
      return { changed: true, notifications: [note] };
    });
    await notifier.deliver(result.notifications);
    return result;
  }

  // ---------------------------------------------------------------------
  // Owner: "I received my item" (before or after the finder's handover)
  // ---------------------------------------------------------------------
  async function confirmReceipt(user, claimId) {
    const result = await withTransaction(pool, async (db) => {
      const { claim, item, linked } = await lockMatch(db, claimId);
      requireParticipant(claim, user);
      if (claim.owner_id !== user.id) throw new HttpError(403, "Only the owner confirms receiving the item", "not_owner");
      if (claim.status !== "accepted") throw new HttpError(409, "This match is not active", "match_not_accepted");
      if (claim.return_confirmed_at) return { changed: false, notifications: [], recoveryId: item?.recovery_id || null };
      if (!claim.unlocked_at) throw new HttpError(402, "Connect first: the ₹100 connection fee unlocks this match", "connection_locked");
      if (!item || item.deleted_at) throw new HttpError(404, "This listing does not exist or was deleted", "item_not_found");

      const notifications = [];
      await db.query("UPDATE claims SET return_confirmed_at = now(), return_confirmed_by = $2, updated_at = now() WHERE id = $1", [claimId, user.id]);
      const listings = [item, linked].filter((l) => l && !l.deleted_at);
      const lost = listings.find((l) => l.type === "lost") || null;
      const found = listings.find((l) => l.type === "found") || null;
      const recovery = await db.query(
        `INSERT INTO recoveries (kind, claim_id, lost_item_id, found_item_id, owner_id, finder_id, completed_by)
         VALUES ('matched', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [claimId, lost?.id ?? null, found?.id ?? null, claim.owner_id, claim.finder_id, user.id]
      );
      const recoveryId = recovery.rows[0].id;
      for (const listing of listings) {
        await db.query(
          `UPDATE items SET status = 'returned', closure_reason = 'returned_matched', recovery_id = $2, status_changed_at = now(), updated_at = now()
           WHERE id = $1`,
          [listing.id, recoveryId]
        );
        await supersedePending(db, listing.id, "item_returned", notifications);
      }
      await event(db, { event: "receipt_confirmed", claimId, itemId: claim.item_id, recoveryId, actorId: user.id, note: claim.handover_at ? "after_handover" : "before_handover" });
      await event(db, { event: "return_completed", claimId, itemId: claim.item_id, recoveryId, actorId: user.id });
      notifications.push(
        await notifier.notify(db, {
          userId: claim.finder_id,
          type: "return_confirmed",
          itemId: claim.item_id,
          data: { claimId: Number(claimId), conversationId: claim.conversation_id ? Number(claim.conversation_id) : null },
          dedupeKey: `claim:${claimId}:returned`,
        })
      );
      return { changed: true, notifications, recoveryId };
    });
    await notifier.deliver(result.notifications);
    return result;
  }

  // ---------------------------------------------------------------------
  // "There is a problem" (owner or finder) — the return stays unresolved
  // ---------------------------------------------------------------------
  async function reportProblem(user, claimId, note) {
    return withTransaction(pool, async (db) => {
      const { claim } = await lockMatch(db, claimId);
      requireParticipant(claim, user);
      if (claim.status !== "accepted") throw new HttpError(409, "This match is not active", "match_not_accepted");
      if (claim.return_confirmed_at) throw new HttpError(409, "This return is already complete. Request a correction instead.", "return_completed");
      const inserted = await db.query(
        `INSERT INTO support_requests (kind, claim_id, item_id, requester_id, message) VALUES ('return_issue', $1, $2, $3, $4)
         ON CONFLICT (claim_id, requester_id) WHERE kind = 'return_issue' AND status = 'open' DO NOTHING RETURNING id`,
        [claimId, claim.item_id, user.id, note]
      );
      if (inserted.rowCount) await event(db, { event: "problem_reported", claimId, itemId: claim.item_id, actorId: user.id, note });
      return { changed: Boolean(inserted.rowCount), supportId: inserted.rows[0]?.id ? Number(inserted.rows[0].id) : null };
    });
  }

  // ---------------------------------------------------------------------
  // What closing a listing would affect (shown before confirmation)
  // ---------------------------------------------------------------------
  async function closurePreview(user, item) {
    const { rows } = await pool.query(
      `SELECT c.id, c.item_id, c.linked_item_id, c.owner_id, c.finder_id, conv.unlocked_at,
              EXISTS (SELECT 1 FROM connection_payments p WHERE p.claim_id = c.id AND p.status = 'paid') AS paid
       FROM claims c LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
       WHERE c.status = 'accepted' AND c.return_confirmed_at IS NULL AND (c.item_id = $1 OR c.linked_item_id = $1)`,
      [item.id]
    );
    const pending = await pool.query("SELECT count(*)::int AS n FROM claims WHERE item_id = $1 AND status = 'pending'", [item.id]);
    const match = rows[0];
    return {
      activeMatch: match ? { claimId: Number(match.id), unlocked: Boolean(match.unlocked_at), paid: match.paid, viewerIsOwner: match.owner_id === user.id } : null,
      pendingClaims: pending.rows[0].n,
    };
  }

  // ---------------------------------------------------------------------
  // "I found it myself" (lost poster) / "Returned outside the platform" (found poster)
  // ---------------------------------------------------------------------
  async function closeWithRecovery(user, itemId, kind, note) {
    const reason = kind === "self_recovered" ? "self_recovered" : "returned_external";
    const claimReason = kind === "self_recovered" ? "item_self_recovered" : "item_returned_externally";
    const result = await withTransaction(pool, async (db) => {
      const { item, items, claims } = await lockListing(db, itemId);
      if (!item || item.deleted_at) throw new HttpError(404, "This listing does not exist or was deleted", "item_not_found");
      if (item.user_id !== user.id) throw new HttpError(403, "Only the person who posted this listing can do that", "forbidden");
      if (item.moderation_state === "removed") throw new HttpError(409, "This listing was removed by a moderator", "item_removed");
      if (kind === "self_recovered" && item.type !== "lost") throw new HttpError(400, "Only a lost listing can be marked as found by its owner", "wrong_listing_type");
      if (kind === "external" && item.type !== "found") throw new HttpError(400, "Only a found listing can be marked as returned outside the platform", "wrong_listing_type");
      if (item.status === "closed" && item.closure_reason === reason) return { changed: false, notifications: [], paidConnections: [] };
      if (!["open", "claimed"].includes(item.status)) {
        throw new HttpError(409, `A ${item.status} listing can't be closed this way`, "invalid_transition", { from: item.status });
      }
      const completed = claims.find((c) => c.return_confirmed_at);
      if (completed) throw new HttpError(409, "This return is already complete", "return_completed");

      const notifications = [];
      const paidConnections = [];
      // Cancel the active match (if any) and release the other listing.
      for (const claim of claims) {
        await db.query("UPDATE claims SET status = 'revoked', close_reason = $2, decided_at = now(), updated_at = now() WHERE id = $1", [claim.id, claimReason]);
        const otherId = claim.item_id === itemId ? claim.linked_item_id : claim.item_id;
        const other = items.find((i) => i.id === otherId);
        if (other && other.status === "claimed") {
          await db.query("UPDATE items SET status = 'open', status_changed_at = now(), updated_at = now() WHERE id = $1", [other.id]);
        }
        const counterpart = claim.owner_id === user.id ? claim.finder_id : claim.owner_id;
        const paid = await db.query("SELECT id, status FROM connection_payments WHERE claim_id = $1 AND status IN ('paid', 'refund_pending', 'refunded')", [claim.id]);
        if (paid.rows[0]) paidConnections.push({ claimId: Number(claim.id), paymentStatus: paid.rows[0].status, refundRequestable: paid.rows[0].status === "paid" && claim.owner_id === user.id });
        await event(db, { event: "match_cancelled", claimId: claim.id, itemId, actorId: user.id, note: claimReason });
        if (counterpart) {
          notifications.push(
            await notifier.notify(db, {
              userId: counterpart,
              type: "item_status",
              itemId: claim.item_id,
              data: { status: "closed", closureReason: reason, claimId: Number(claim.id) },
              dedupeKey: `claim:${claim.id}:closed:${reason}`,
            })
          );
        }
      }
      await supersedePending(db, itemId, claimReason, notifications);
      const recovery = await db.query(
        `INSERT INTO recoveries (kind, lost_item_id, found_item_id, owner_id, finder_id, completed_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        kind === "self_recovered"
          ? ["self_recovered", itemId, null, user.id, null, user.id]
          : ["external", null, itemId, null, user.id, user.id]
      );
      const recoveryId = recovery.rows[0].id;
      await db.query(
        `UPDATE items SET status = 'closed', closure_reason = $2, recovery_id = $3, status_changed_at = now(), updated_at = now() WHERE id = $1`,
        [itemId, reason, recoveryId]
      );
      await event(db, { event: kind === "self_recovered" ? "self_recovered" : "external_return", itemId, recoveryId, actorId: user.id, note: note || null });
      return { changed: true, notifications, paidConnections, recoveryId };
    });
    await notifier.deliver(result.notifications);
    return result;
  }

  // ---------------------------------------------------------------------
  // Corrections: participants request, moderators/admins resolve
  // ---------------------------------------------------------------------
  async function requestCorrection(user, itemId, reason) {
    return withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT r.* FROM items i JOIN recoveries r ON r.id = i.recovery_id WHERE i.id = $1 AND r.corrected_at IS NULL FOR UPDATE OF r`,
        [itemId]
      );
      const recovery = rows[0];
      if (!recovery) throw new HttpError(409, "There is no completed return on this listing to correct", "no_recovery");
      if (recovery.owner_id !== user.id && recovery.finder_id !== user.id) throw new HttpError(404, "Return not found", "recovery_not_found");
      const inserted = await db.query(
        `INSERT INTO support_requests (kind, claim_id, item_id, recovery_id, requester_id, message) VALUES ('return_correction', $1, $2, $3, $4, $5)
         ON CONFLICT (recovery_id) WHERE kind = 'return_correction' AND status = 'open' DO NOTHING RETURNING id`,
        [recovery.claim_id, itemId, recovery.id, user.id, reason]
      );
      if (inserted.rowCount) await event(db, { event: "correction_requested", claimId: recovery.claim_id, itemId, recoveryId: recovery.id, actorId: user.id, note: reason });
      return { changed: Boolean(inserted.rowCount), supportId: inserted.rows[0]?.id ? Number(inserted.rows[0].id) : null };
    });
  }

  // Applied by a moderator from the support queue. Reopening:
  //  - matched return: the match stays accepted and goes back to "being
  //    arranged" (receipt and handover cleared); the listing(s) become active.
  //  - self-recovered / external / legacy: the listing reopens (or returns to
  //    "being arranged" if a match is still accepted on it).
  //  Claims closed by the completion stay closed: those people must submit a
  //  new claim. The recovery row is kept and marked corrected (not counted).
  async function applyCorrection(db, { request, moderator, note }) {
    const recovery = (await db.query("SELECT * FROM recoveries WHERE id = $1 FOR UPDATE", [request.recovery_id])).rows[0];
    if (!recovery || recovery.corrected_at) return { changed: false, notifications: [] };
    const ids = [recovery.lost_item_id, recovery.found_item_id].filter(Boolean);
    const items = (await db.query("SELECT * FROM items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids])).rows;
    const notifications = [];
    let claim = null;
    if (recovery.claim_id) {
      claim = (await db.query("SELECT * FROM claims WHERE id = $1 FOR UPDATE", [recovery.claim_id])).rows[0] || null;
    }
    await db.query("UPDATE recoveries SET corrected_at = now(), corrected_by = $2, correction_reason = $3 WHERE id = $1", [recovery.id, moderator.id, note]);
    if (claim && claim.status === "accepted") {
      await db.query("UPDATE claims SET return_confirmed_at = NULL, return_confirmed_by = NULL, handover_at = NULL, handover_by = NULL, updated_at = now() WHERE id = $1", [claim.id]);
    }
    for (const item of items) {
      if (item.recovery_id !== recovery.id) continue;
      const stillMatched = claim && claim.status === "accepted" && (claim.item_id === item.id || claim.linked_item_id === item.id);
      const hasAccepted = stillMatched || (await db.query("SELECT 1 FROM claims WHERE item_id = $1 AND status = 'accepted'", [item.id])).rowCount > 0;
      await db.query(
        "UPDATE items SET status = $2, closure_reason = NULL, recovery_id = NULL, status_changed_at = now(), updated_at = now() WHERE id = $1",
        [item.id, hasAccepted ? "claimed" : "open"]
      );
    }
    await event(db, { event: "correction_applied", claimId: recovery.claim_id, itemId: ids[0] ?? null, recoveryId: recovery.id, actorId: moderator.id, note });
    for (const userId of [...new Set([recovery.owner_id, recovery.finder_id].filter(Boolean))]) {
      notifications.push(
        await notifier.notify(db, {
          userId,
          type: "return_corrected",
          itemId: ids[0] ?? null,
          data: { recoveryId: Number(recovery.id), claimId: recovery.claim_id ? Number(recovery.claim_id) : null },
          dedupeKey: `recovery:${recovery.id}:corrected`,
        })
      );
    }
    return { changed: true, notifications };
  }

  // ---------------------------------------------------------------------
  // Reminders: the owner is nudged; receipt is never auto-confirmed
  // ---------------------------------------------------------------------
  async function sendReturnReminders() {
    const created = [];
    for (const { n, after } of REMINDERS) {
      const { rows } = await pool.query(
        `SELECT c.id, c.item_id, c.owner_id, conv.id AS conversation_id FROM claims c
         LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
         WHERE c.status = 'accepted' AND c.return_confirmed_at IS NULL AND c.handover_at IS NOT NULL
           AND c.handover_at < now() - $1::interval`,
        [after]
      );
      for (const row of rows) {
        await withTransaction(pool, async (db) => {
          const note = await notifier.notify(db, {
            userId: row.owner_id,
            type: "return_reminder",
            itemId: row.item_id,
            data: { claimId: Number(row.id), conversationId: row.conversation_id ? Number(row.conversation_id) : null, reminder: n },
            dedupeKey: `claim:${row.id}:reminder:${n}`,
          });
          if (note) {
            created.push(note);
            await event(db, { event: "reminder_sent", claimId: row.id, itemId: row.item_id, note: `reminder ${n}` });
          }
        });
      }
    }
    await notifier.deliver(created);
    if (created.length) logger.info({ reminders: created.length }, "Return reminders sent");
    return created.length;
  }

  return { lockMatch, lockListing, reportHandover, confirmReceipt, reportProblem, closurePreview, closeWithRecovery, requestCorrection, applyCorrection, sendReturnReminders, event };
}

module.exports = { createReturnService, returnState };
