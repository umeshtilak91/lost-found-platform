"use strict";

// Owner–finder matches ("claims").
//
// Roles are explicit: for a FOUND listing the claimant is the owner and the
// poster is the finder; for a LOST listing the poster is the owner and the
// claimant is the finder. The owner always pays the ₹100 connection fee and
// accepts the category reward (paid directly to the finder).
//
// Path A (lost listing):  finder responds -> owner accepts match + reward -> owner pays -> unlock
// Path B (found listing): owner claims + accepts reward -> finder accepts -> owner pays -> unlock
//
// Concurrency: decisions lock the item row then the claim row; duplicate
// submissions hit partial unique indexes; repeated decisions are idempotent.

const express = require("express");
const { z } = require("zod");
const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");
const { requireUser } = require("../middleware/security");
const { displayName, timestamp } = require("../services/serializers");
const { loadItem, parseId, assertVisible } = require("../services/items");
const { snapshotFor, rewardFor, PRICING_VERSION } = require("../config/pricing");
const { scanFields } = require("../services/contactGuard");
const { ensureConversation } = require("./conversations");
const { returnState } = require("../services/returns");

const CLAIM_SELECT = `
  SELECT c.*, u.name AS claimant_name, conv.id AS conversation_id, conv.unlocked_at, conv.unlock_source,
         i.type AS item_type, i.category AS item_category,
         (SELECT status FROM connection_payments p WHERE p.claim_id = c.id ORDER BY
            CASE WHEN p.status IN ('paid','refund_pending','refunded') THEN 0 ELSE 1 END, p.created_at DESC LIMIT 1) AS payment_status,
         EXISTS (SELECT 1 FROM support_requests s WHERE s.claim_id = c.id AND s.kind = 'return_issue' AND s.status = 'open') AS return_issue_open,
         i.status AS item_status, i.closure_reason AS item_closure_reason
  FROM claims c
  JOIN users u ON u.id = c.claimant_id
  JOIN items i ON i.id = c.item_id
  LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id`;

function serializeClaim(row, viewerId) {
  const agreement = row.owner_accepted_at
    ? {
        category: row.agreement_category,
        rewardPaise: row.reward_paise,
        feePaise: row.fee_paise,
        currency: row.currency,
        pricingVersion: row.pricing_version,
        termsVersion: row.terms_version,
        acceptedAt: timestamp(row.owner_accepted_at),
        current: row.pricing_version === PRICING_VERSION && row.agreement_category === row.item_category,
      }
    : null;
  return {
    id: Number(row.id),
    itemId: row.item_id,
    status: row.status,
    claimant: { id: row.claimant_id, displayName: displayName(row.claimant_name) },
    viewerRole: viewerId === row.owner_id ? "owner" : viewerId === row.finder_id ? "finder" : null,
    claimantRole: row.claimant_id === row.owner_id ? "owner" : "finder",
    answer: row.answer,
    agreement,
    payment: { status: row.payment_status || "none" },
    unlocked: Boolean(row.unlocked_at),
    unlockSource: row.unlock_source || null,
    returnConfirmedAt: timestamp(row.return_confirmed_at),
    handoverAt: timestamp(row.handover_at),
    // arranging | awaiting_owner | returned | awaiting_connection | null (not an active match)
    returnState: returnState(row),
    returnIssueOpen: Boolean(row.return_issue_open),
    linkedItemId: row.linked_item_id ?? null,
    closeReason: row.close_reason || null,
    item: { status: row.item_status, closureReason: row.item_closure_reason || null },
    reward: { status: row.reward_status, at: timestamp(row.reward_status_at), note: row.reward_issue_note || null },
    createdAt: timestamp(row.created_at),
    decidedAt: timestamp(row.decided_at),
    conversationId: row.conversation_id ? Number(row.conversation_id) : null,
  };
}

// Validates the owner's acceptance of the *current* category reward. The
// client echoes the amount it showed, so a stale screen or a tampered amount
// is rejected instead of silently agreeing to something else.
function requireRewardAcceptance(input, category) {
  if (input.acceptReward !== true) throw new HttpError(400, "Please accept the finder reward to continue", "terms_required");
  const current = rewardFor(category);
  if (input.expectedRewardPaise !== current) {
    throw new HttpError(409, "The reward for this category has changed. Review the new amount.", "pricing_changed", { rewardPaise: current });
  }
  return snapshotFor(category);
}

const acceptanceSchema = z
  .object({
    acceptReward: z.boolean().optional(),
    expectedRewardPaise: z.number().int().positive().optional(),
  })
  .strict();

function claimRoutes({ pool, notifier, limits, returns }) {
  const router = express.Router();

  async function loadClaimRow(db, claimId) {
    const { rows } = await db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [claimId]);
    return rows[0];
  }

  // -----------------------------------------------------------------------
  // Submit a claim / response
  // -----------------------------------------------------------------------
  router.post("/items/:id/claims", requireUser, limits.claim, async (req, res) => {
    const itemId = parseId(req.params.id, "Item ID");
    const input = acceptanceSchema
      .extend({
        answer: z.string().trim().min(1, "Please answer the question").max(1000),
        // The claimant's own listing of the opposite type for the same item.
        linkedItemId: z.number().int().positive().max(2147483647).optional(),
      })
      .strict()
      .parse(req.body || {});

    const contact = scanFields({ answer: input.answer });
    if (Object.keys(contact).length) {
      throw new HttpError(422, "Please remove phone numbers, emails, UPI IDs or links. Contact details unlock after the connection is paid.", "contact_detected", {
        fields: contact,
      });
    }

    const result = await withTransaction(pool, async (db) => {
      // Lock the listing and the linked listing in id order (same order as every other transition).
      const lockIds = [itemId, input.linkedItemId].filter(Boolean);
      const locked = (await db.query("SELECT * FROM items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [lockIds])).rows;
      const item = assertVisible(locked.find((r) => r.id === itemId) || null, req.user);
      if (item.user_id === req.user.id) throw new HttpError(400, "You cannot claim your own listing", "own_listing");
      if (input.linkedItemId) {
        const linked = locked.find((r) => r.id === input.linkedItemId);
        if (!linked || linked.deleted_at || linked.user_id !== req.user.id) throw new HttpError(400, "You can only link one of your own listings", "invalid_linked_item");
        if (linked.type === item.type) throw new HttpError(400, "Link a listing of the opposite type (lost ↔ found)", "invalid_linked_item");
        if (linked.status !== "open" || linked.moderation_state !== "visible") throw new HttpError(409, "Your linked listing is not open", "linked_item_unavailable");
      }
      if (item.moderation_state !== "visible") throw new HttpError(410, "This listing is no longer available", "item_removed");
      if (item.status !== "open") throw new HttpError(409, "This listing is not accepting claims right now", "not_open");
      if (!item.user_id) throw new HttpError(409, "The person who posted this listing has left", "reporter_gone");
      if (!item.category_confirmed) {
        throw new HttpError(409, "The poster needs to confirm this listing's category before matches can start", "category_unconfirmed");
      }

      const claimantIsOwner = item.type === "found";
      const snapshot = claimantIsOwner ? requireRewardAcceptance(input, item.category) : null;
      const ownerId = claimantIsOwner ? req.user.id : item.user_id;
      const finderId = claimantIsOwner ? item.user_id : req.user.id;

      const inserted = await db.query(
        `INSERT INTO claims (item_id, claimant_id, answer, owner_id, finder_id,
                             agreement_category, reward_paise, fee_paise, currency, pricing_version, terms_version, owner_accepted_at, linked_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $12)
         ON CONFLICT (item_id, claimant_id) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [
          itemId,
          req.user.id,
          input.answer,
          ownerId,
          finderId,
          snapshot?.category ?? null,
          snapshot?.rewardPaise ?? null,
          snapshot?.feePaise ?? null,
          snapshot?.currency ?? null,
          snapshot?.pricingVersion ?? null,
          snapshot?.termsVersion ?? null,
          input.linkedItemId ?? null,
        ]
      );
      const conversation = await ensureConversation(db, item, req.user.id);
      let claimId = inserted.rows[0]?.id;
      const notifications = [];
      if (claimId) {
        notifications.push(
          await notifier.notify(db, {
            userId: item.user_id,
            type: "claim_received",
            itemId,
            data: { claimId: Number(claimId), conversationId: Number(conversation.id) },
            dedupeKey: `claim:${claimId}:received`,
          })
        );
      } else {
        const existing = await db.query("SELECT id FROM claims WHERE item_id = $1 AND claimant_id = $2 AND status = 'pending'", [itemId, req.user.id]);
        claimId = existing.rows[0].id;
      }
      return { claim: await loadClaimRow(db, claimId), created: Boolean(inserted.rows[0]), notifications };
    });

    await notifier.deliver(result.notifications);
    res.status(result.created ? 201 : 200).json({ claim: serializeClaim(result.claim, req.user.id), created: result.created });
  });

  // Owner-claimant renews acceptance (category or pricing changed since claiming).
  router.post("/claims/:id/terms", requireUser, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const input = acceptanceSchema.parse({ acceptReward: true, ...(req.body || {}) });
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db.query("SELECT c.*, i.category FROM claims c JOIN items i ON i.id = c.item_id WHERE c.id = $1 FOR UPDATE OF c", [claimId]);
      const claim = rows[0];
      if (!claim || claim.claimant_id !== req.user.id || claim.owner_id !== req.user.id) throw new HttpError(404, "Match not found", "claim_not_found");
      if (claim.status !== "pending") throw new HttpError(409, "Terms can only be renewed on a pending claim", "claim_not_pending");
      const snapshot = requireRewardAcceptance(input, claim.category);
      await db.query(
        `UPDATE claims SET agreement_category = $2, reward_paise = $3, fee_paise = $4, currency = $5, pricing_version = $6,
                terms_version = $7, owner_accepted_at = now(), updated_at = now() WHERE id = $1`,
        [claimId, snapshot.category, snapshot.rewardPaise, snapshot.feePaise, snapshot.currency, snapshot.pricingVersion, snapshot.termsVersion]
      );
      return loadClaimRow(db, claimId);
    });
    res.json({ claim: serializeClaim(row, req.user.id) });
  });

  // Poster sees every claim; a claimant sees only their own.
  router.get("/items/:id/claims", requireUser, async (req, res) => {
    const itemId = parseId(req.params.id, "Item ID");
    const item = assertVisible(await loadItem(pool, itemId), req.user);
    const isPoster = item.user_id === req.user.id;
    const { rows } = await pool.query(
      `${CLAIM_SELECT} WHERE c.item_id = $1 ${isPoster ? "" : "AND c.claimant_id = $2"} ORDER BY c.created_at DESC, c.id DESC`,
      isPoster ? [itemId] : [itemId, req.user.id]
    );
    res.json({ claims: rows.map((row) => serializeClaim(row, req.user.id)) });
  });

  // -----------------------------------------------------------------------
  // Decisions
  // -----------------------------------------------------------------------
  async function decide(req, action) {
    const claimId = parseId(req.params.id, "Match ID");
    const lookup = await pool.query("SELECT item_id, linked_item_id FROM claims WHERE id = $1", [claimId]);
    if (!lookup.rows[0]) throw new HttpError(404, "Claim not found", "claim_not_found");
    const itemId = lookup.rows[0].item_id;
    const input = action === "accept" ? acceptanceSchema.parse(req.body || {}) : {};

    return withTransaction(pool, async (db) => {
      const ids = [itemId, lookup.rows[0].linked_item_id].filter(Boolean);
      const locked = (await db.query("SELECT * FROM items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids])).rows;
      const item = locked.find((r) => r.id === itemId) || null;
      const linked = locked.find((r) => r.id === lookup.rows[0].linked_item_id) || null;
      const { rows } = await db.query("SELECT * FROM claims WHERE id = $1 FOR UPDATE", [claimId]);
      const claim = rows[0];
      const isPoster = item && item.user_id === req.user.id;
      const isClaimant = claim.claimant_id === req.user.id;

      if (action === "withdraw" ? !isClaimant : !isPoster) {
        throw new HttpError(isPoster || isClaimant ? 403 : 404, isPoster || isClaimant ? "You cannot do that" : "Claim not found", isPoster || isClaimant ? "forbidden" : "claim_not_found");
      }
      if (!item || item.deleted_at) throw new HttpError(404, "This listing does not exist or was deleted", "item_not_found");

      const target = { accept: "accepted", decline: "declined", withdraw: "withdrawn" }[action];
      if (claim.status === target) return { claim, notifications: [], changed: false };
      if (claim.status !== "pending") throw new HttpError(409, `This claim is already ${claim.status}`, "claim_not_pending", { status: claim.status });

      let snapshotSql = "";
      let snapshotParams = [];
      if (action === "accept") {
        if (item.moderation_state !== "visible") throw new HttpError(409, "This listing was removed by a moderator", "item_removed");
        if (item.status !== "open") throw new HttpError(409, "Another claim was already accepted for this listing", "item_not_open");
        if (!item.category_confirmed) throw new HttpError(409, "Confirm this listing's category first", "category_unconfirmed");
        if (claim.linked_item_id && (!linked || linked.deleted_at || linked.status !== "open")) {
          throw new HttpError(409, "The claimant's linked listing is no longer open", "linked_item_unavailable");
        }

        if (item.type === "lost") {
          // Path A: the poster is the owner and accepts the reward now.
          const snapshot = requireRewardAcceptance(input, item.category);
          snapshotSql = `, agreement_category = $3, reward_paise = $4, fee_paise = $5, currency = $6, pricing_version = $7, terms_version = $8, owner_accepted_at = now()`;
          snapshotParams = [snapshot.category, snapshot.rewardPaise, snapshot.feePaise, snapshot.currency, snapshot.pricingVersion, snapshot.termsVersion];
        } else {
          // Path B: the owner (claimant) must hold a current agreement.
          const current = claim.owner_accepted_at && claim.pricing_version === PRICING_VERSION && claim.agreement_category === item.category;
          if (!current) {
            const note = await notifier.notify(db, {
              userId: claim.claimant_id,
              type: "claim_update",
              itemId,
              data: { claimId, status: "terms_renewal_required" },
              dedupeKey: `claim:${claimId}:renew:${PRICING_VERSION}:${item.category}`,
            });
            return { claim, notifications: [note], changed: false, renewalRequired: true };
          }
        }
      }

      const updated = await db.query(
        `UPDATE claims SET status = $1, decided_at = now(), updated_at = now() ${snapshotSql} WHERE id = $2 RETURNING *`,
        [target, claimId, ...snapshotParams]
      );
      if (action === "accept") {
        // Both listings of a linked recovery show "return being arranged" and pause new claims.
        await db.query("UPDATE items SET status = 'claimed', status_changed_at = now(), updated_at = now() WHERE id = ANY($1::int[])", [
          [itemId, claim.linked_item_id].filter(Boolean),
        ]);
      }

      const notifications = [];
      if (action === "withdraw") {
        notifications.push(
          await notifier.notify(db, { userId: item.user_id, type: "claim_update", itemId, data: { claimId, status: target }, dedupeKey: `claim:${claimId}:${target}` })
        );
      } else {
        notifications.push(
          await notifier.notify(db, { userId: claim.claimant_id, type: "claim_update", itemId, data: { claimId, status: target }, dedupeKey: `claim:${claimId}:${target}` })
        );
        if (action === "accept") {
          const conv = await db.query("SELECT unlocked_at FROM conversations WHERE item_id = $1 AND participant_id = $2", [itemId, claim.claimant_id]);
          if (!conv.rows[0]?.unlocked_at) {
            notifications.push(
              await notifier.notify(db, {
                userId: updated.rows[0].owner_id,
                type: "payment_due",
                itemId,
                data: { claimId },
                dedupeKey: `claim:${claimId}:payment_due`,
              })
            );
          }
        }
      }
      return { claim: updated.rows[0], notifications, changed: true };
    });
  }

  for (const action of ["accept", "decline", "withdraw"]) {
    router.post(`/claims/:id/${action}`, requireUser, limits.claim, async (req, res) => {
      const result = await decide(req, action);
      await notifier.deliver(result.notifications);
      if (result.renewalRequired) {
        throw new HttpError(409, "The owner must re-accept the current reward before you can accept this claim. We've notified them.", "terms_renewal_required");
      }
      const row = await loadClaimRow(pool, result.claim.id);
      res.json({ claim: serializeClaim(row, req.user.id), changed: result.changed });
    });
  }

  // -----------------------------------------------------------------------
  // After the connection: return confirmation and direct-reward status
  // -----------------------------------------------------------------------
  async function loadUnlockedForParticipant(db, claimId, user) {
    const { rows } = await db.query(
      `SELECT c.*, conv.unlocked_at FROM claims c
       LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [claimId]
    );
    const claim = rows[0];
    if (!claim || (claim.owner_id !== user.id && claim.finder_id !== user.id)) throw new HttpError(404, "Match not found", "claim_not_found");
    if (claim.status !== "accepted") throw new HttpError(409, "This match is not active", "match_not_accepted");
    if (!claim.unlocked_at) throw new HttpError(402, "Connect first: the ₹100 connection fee unlocks this match", "connection_locked");
    return claim;
  }

  // Owner: "I received my item" — completes the return (idempotent).
  router.post("/claims/:id/return", requireUser, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const result = await returns.confirmReceipt(req.user, claimId);
    res.json({ claim: serializeClaim(await loadClaimRow(pool, claimId), req.user.id), changed: result.changed });
  });

  // Finder: "I handed over this item" — waits for the owner's confirmation.
  router.post("/claims/:id/handover", requireUser, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const result = await returns.reportHandover(req.user, claimId);
    res.json({ claim: serializeClaim(await loadClaimRow(pool, claimId), req.user.id), changed: result.changed });
  });

  // Owner or finder: "There is a problem" — recorded for support; the return stays unresolved.
  router.post("/claims/:id/return-issue", requireUser, limits.abuse, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const { note } = z.object({ note: z.string().trim().min(5, "Tell us what happened (at least 5 characters)").max(1000) }).strict().parse(req.body || {});
    const result = await returns.reportProblem(req.user, claimId, note);
    res.status(result.changed ? 201 : 200).json({
      claim: serializeClaim(await loadClaimRow(pool, claimId), req.user.id),
      changed: result.changed,
    });
  });

  router.post("/claims/:id/reward", requireUser, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const { status, note } = z
      .object({ status: z.enum(["confirmed", "issue"]), note: z.string().trim().max(1000).optional() })
      .strict()
      .parse(req.body || {});
    const result = await withTransaction(pool, async (db) => {
      const claim = await loadUnlockedForParticipant(db, claimId, req.user);
      if (claim.finder_id !== req.user.id) throw new HttpError(403, "Only the finder reports reward receipt", "not_finder");
      // Reward receipt is tracked only after the physical return is complete.
      if (!claim.return_confirmed_at) throw new HttpError(409, "The reward can be confirmed once the owner confirms the return", "return_not_completed");
      if (claim.reward_status === status) return { changed: false, notifications: [] };
      if (claim.reward_status === "confirmed") throw new HttpError(409, "You already confirmed receiving the reward", "reward_confirmed");
      if (status === "issue" && !note) throw new HttpError(400, "Please describe the payment issue", "note_required");
      await db.query(
        "UPDATE claims SET reward_status = $2, reward_status_at = now(), reward_status_by = $3, reward_issue_note = $4, updated_at = now() WHERE id = $1",
        [claimId, status, req.user.id, status === "issue" ? note : claim.reward_issue_note]
      );
      if (status === "issue") {
        await db.query("INSERT INTO support_requests (kind, claim_id, item_id, requester_id, message) VALUES ('reward_issue', $1, $2, $3, $4)", [claimId, claim.item_id, req.user.id, note]);
      }
      // Separate from the return: never reopens the listing or changes the return record.
      await returns.event(db, { event: status === "confirmed" ? "reward_confirmed" : "reward_issue", claimId, itemId: claim.item_id, actorId: req.user.id, note: status === "issue" ? note : null });
      const notification = await notifier.notify(db, {
        userId: claim.owner_id,
        type: "reward_update",
        itemId: claim.item_id,
        data: { claimId, status },
        dedupeKey: `claim:${claimId}:reward:${status}`,
      });
      return { changed: true, notifications: [notification] };
    });
    await notifier.deliver(result.notifications);
    res.json({ claim: serializeClaim(await loadClaimRow(pool, claimId), req.user.id), changed: result.changed });
  });

  // Connection-fee refund request (manual review; see docs/payments.md).
  router.post("/claims/:id/refund-request", requireUser, limits.abuse, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const { reason } = z.object({ reason: z.string().trim().min(10, "Tell us what happened (at least 10 characters)").max(1000) }).strict().parse(req.body || {});
    const { rows } = await pool.query(
      `SELECT c.owner_id, p.id AS payment_id, p.status FROM claims c
       LEFT JOIN connection_payments p ON p.claim_id = c.id AND p.status IN ('paid', 'refund_pending', 'refunded')
       WHERE c.id = $1`,
      [claimId]
    );
    const row = rows[0];
    if (!row || row.owner_id !== req.user.id) throw new HttpError(404, "Match not found", "claim_not_found");
    if (!row.payment_id || row.status !== "paid") throw new HttpError(409, "There is no paid connection fee to refund", "not_refundable");
    const inserted = await pool.query(
      `INSERT INTO support_requests (kind, claim_id, payment_id, requester_id, message) VALUES ('refund', $1, $2, $3, $4)
       ON CONFLICT (payment_id) WHERE kind = 'refund' AND status = 'open' DO NOTHING RETURNING id`,
      [claimId, row.payment_id, req.user.id, reason]
    );
    res.status(inserted.rowCount ? 201 : 200).json({ ok: true, alreadyRequested: !inserted.rowCount });
  });

  return router;
}

module.exports = { claimRoutes, serializeClaim, CLAIM_SELECT };
