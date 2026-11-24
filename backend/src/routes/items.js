"use strict";

const express = require("express");
const { z } = require("zod");
const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");
const { requireUser } = require("../middleware/security");
const { parseUploads, storeImages, imagePaths } = require("../services/images");
const { publicItem, ownerItem, timestamp } = require("../services/serializers");
const { findMatches, notifyMatches } = require("../services/matching");
const { rewardFor, snapshotFor } = require("../config/pricing");
const { scanFields } = require("../services/contactGuard");
const { CATEGORIES } = require("../services/items");
const { resolveItemLocation } = require("../services/locations");

// Text-only location (no coordinates) for listings that don't send metadata.
const MANUAL_LOCATION = Object.freeze({
  location_source: "manual",
  location_provider: null,
  location_place_id: null,
  location_country: null,
  location_admin_area: null,
  latitude: null,
  longitude: null,
  location_accuracy_m: null,
  location_coords_at: null,
});

// Public listing text is visible before any connection is paid, so contact
// details are blocked. The poster can edit, or ask a moderator to review a
// false positive (the listing stays hidden until approved).
function contactCheck(input) {
  const hits = scanFields({
    title: input.title,
    description: input.description,
    location: input.location,
    ownershipQuestion: input.ownershipQuestion,
  });
  if (!Object.keys(hits).length) return { flagged: false };
  if (input.reviewRequested) return { flagged: true, hits };
  throw new HttpError(
    422,
    "Listings can't include phone numbers, emails, UPI IDs or links. Contact details unlock after a paid connection. Edit the highlighted fields, or send the listing for review if this is a mistake.",
    "contact_detected",
    { fields: hits }
  );
}

// Owners of lost items agree to the category reward when publishing.
function rewardAcknowledgement(input, category) {
  if (input.acceptRewardTerms !== true) {
    throw new HttpError(400, "Please agree to the finder reward and connection fee", "terms_required", { fields: { acceptRewardTerms: ["required"] } });
  }
  const current = rewardFor(category);
  if (input.expectedRewardPaise !== current) {
    throw new HttpError(409, "The reward for this category has changed. Review the new amount.", "pricing_changed", { rewardPaise: current });
  }
  return snapshotFor(category);
}
const {
  TRANSITIONS,
  ITEM_SELECT,
  searchItems,
  imagesFor,
  loadItem,
  parseId,
  assertVisible,
  assertOwner,
  isModerator,
  itemInputSchema,
} = require("../services/items");

function itemRoutes({ pool, config, storage, notifier, limits, logger, places, returns }) {
  const router = express.Router();
  const uploads = parseUploads(config.uploads);

  async function serializeOne(db, row, user) {
    const images = (await imagesFor(db, [row.id])).get(row.id) || [];
    const owner = user && row.user_id === user.id;
    return owner || isModerator(user) ? ownerItem(row, images) : publicItem(row, images);
  }

  // Viewer-specific context for the detail page (never part of public output).
  async function viewerContext(db, row, user) {
    if (!user) return { isOwner: false, canModerate: false, claim: null, conversationId: null };
    const isOwner = row.user_id === user.id;
    const [claim, conversation, report] = await Promise.all([
      isOwner
        ? null
        : db.query(
            "SELECT id, status, created_at FROM claims WHERE item_id = $1 AND claimant_id = $2 ORDER BY created_at DESC LIMIT 1",
            [row.id, user.id]
          ),
      isOwner ? null : db.query("SELECT id FROM conversations WHERE item_id = $1 AND participant_id = $2", [row.id, user.id]),
      db.query("SELECT 1 FROM listing_reports WHERE item_id = $1 AND reporter_id = $2 AND status = 'open'", [row.id, user.id]),
    ]);
    let pendingClaims = 0;
    if (isOwner) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM claims WHERE item_id = $1 AND status = 'pending'", [row.id]);
      pendingClaims = rows[0].n;
    }
    return {
      isOwner,
      canModerate: isModerator(user),
      claim: claim?.rows[0] ? { id: Number(claim.rows[0].id), status: claim.rows[0].status } : null,
      conversationId: conversation?.rows[0] ? Number(conversation.rows[0].id) : null,
      hasReported: report.rowCount > 0,
      pendingClaims,
    };
  }

  // ---------------------------------------------------------------------
  // Public browsing
  // ---------------------------------------------------------------------
  router.get("/items", async (req, res) => {
    const result = await searchItems(pool, req.query);
    const images = await imagesFor(pool, result.rows.map((row) => row.id));
    res.json({
      items: result.rows.map((row) => publicItem(row, images.get(row.id) || [])),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    });
  });

  // Listing counts come from items; recovery counts come from `recoveries`,
  // one row per recovery (linked lost+found listings count once; corrected
  // recoveries are excluded). See docs/returns.md for what each metric means.
  router.get("/stats", async (req, res) => {
    const [listings, recoveries] = await Promise.all([
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE type = 'lost')::int AS lost,
               count(*) FILTER (WHERE type = 'found')::int AS found,
               count(*) FILTER (WHERE status IN ('open', 'claimed'))::int AS active
        FROM items WHERE deleted_at IS NULL AND moderation_state = 'visible'`),
      pool.query(`
        SELECT count(*) FILTER (WHERE kind = 'matched')::int AS returned,
               count(*) FILTER (WHERE kind = 'self_recovered')::int AS self_recovered,
               count(*) FILTER (WHERE kind = 'external')::int AS external,
               count(*) FILTER (WHERE kind = 'legacy')::int AS legacy
        FROM recoveries WHERE corrected_at IS NULL`),
    ]);
    const r = recoveries.rows[0];
    res.set("Cache-Control", "public, max-age=15").json({
      ...listings.rows[0],
      returned: r.returned, // owner-confirmed returns through a match
      selfRecovered: r.self_recovered,
      externalReturns: r.external,
      legacyReturned: r.legacy,
    });
  });

  router.get("/items/:id", async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const row = assertVisible(await loadItem(pool, id), req.user);
    res.set("Cache-Control", "private, no-store");
    res.json({ item: await serializeOne(pool, row, req.user), viewer: await viewerContext(pool, row, req.user) });
  });

  // ---------------------------------------------------------------------
  // Owner listings
  // ---------------------------------------------------------------------
  router.get("/me/items", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `${ITEM_SELECT} WHERE i.user_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC, i.id DESC LIMIT 200`,
      [req.user.id]
    );
    const images = await imagesFor(pool, rows.map((row) => row.id));
    const pending = await pool.query(
      `SELECT item_id, count(*)::int AS n FROM claims
       WHERE status = 'pending' AND item_id = ANY($1) GROUP BY item_id`,
      [rows.map((row) => row.id)]
    );
    const pendingByItem = new Map(pending.rows.map((row) => [row.item_id, row.n]));
    res.json({
      items: rows.map((row) => ({ ...ownerItem(row, images.get(row.id) || []), pendingClaims: pendingByItem.get(row.id) || 0 })),
    });
  });

  router.post("/items", requireUser, limits.report, limits.upload, uploads, async (req, res) => {
    const input = itemInputSchema({ partial: false }).parse(req.body || {});
    const { flagged } = contactCheck(input);
    // Resolve the place before any upload work (a bad place ID fails fast).
    const place = (await resolveItemLocation(input, { places })) || MANUAL_LOCATION;
    const reward = input.type === "lost" ? rewardAcknowledgement(input, input.category) : null;
    const files = req.files || [];
    const { images, keys } = await storeImages(files, { storage, uploads: config.uploads });

    let created;
    try {
      created = await withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `INSERT INTO items (type, name, category, description, location, date, latitude, longitude,
                              ownership_question, user_id, status, moderation_state, category_confirmed,
                              reward_paise, reward_pricing_version, reward_terms_version, reward_accepted_at,
                              location_source, location_provider, location_place_id, location_country,
                              location_admin_area, location_accuracy_m, location_coords_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, TRUE, $12, $13, $14, CASE WHEN $12::int IS NULL THEN NULL ELSE now() END,
                   $15, $16, $17, $18, $19, $20, $21)
           RETURNING *`,
          [
            input.type,
            input.title,
            input.category,
            input.description || null,
            input.location,
            input.date,
            place.latitude,
            place.longitude,
            input.ownershipQuestion || null,
            req.user.id,
            flagged ? "pending" : "visible",
            reward?.rewardPaise ?? null,
            reward?.pricingVersion ?? null,
            reward?.termsVersion ?? null,
            place.location_source,
            place.location_provider,
            place.location_place_id,
            place.location_country,
            place.location_admin_area,
            place.location_accuracy_m,
            place.location_coords_at,
          ]
        );
        const item = rows[0];
        for (const [position, image] of images.entries()) {
          await db.query(
            `INSERT INTO item_images (item_id, storage_key, thumb_key, width, height, position)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [item.id, image.storageKey, image.thumbKey, image.width, image.height, position]
          );
        }
        const notifications = await notifyMatches(db, notifier, item);
        return { item, notifications };
      });
    } catch (error) {
      // Database write failed: remove the images we just stored.
      await storage.remove(keys).catch((cleanupError) => logger.error({ err: cleanupError }, "Image cleanup failed"));
      throw error;
    }

    await notifier.deliver(created.notifications);
    const row = await loadItem(pool, created.item.id);
    res.status(201).json({ item: await serializeOne(pool, row, req.user) });
  });

  router.patch("/items/:id", requireUser, limits.upload, uploads, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const input = itemInputSchema({ partial: true }).parse(req.body || {});
    const files = req.files || [];

    // Authorize before doing any image work.
    const existing = assertOwner(await loadItem(pool, id), req.user);
    if (existing.moderation_state === "removed") {
      throw new HttpError(409, "A removed listing cannot be edited", "item_removed");
    }
    const place = await resolveItemLocation(input, { places, existing });
    const merged = {
      title: input.title ?? existing.name,
      description: input.description ?? existing.description,
      location: input.location ?? existing.location,
      ownershipQuestion: input.ownershipQuestion ?? existing.ownership_question,
      reviewRequested: input.reviewRequested,
    };
    const { flagged } = contactCheck(merged);
    const categoryChanged = input.category !== undefined && input.category !== existing.category;
    if (categoryChanged && existing.status !== "open") {
      throw new HttpError(409, "The category can't change while a match is in progress", "category_locked");
    }
    // A lost listing's owner re-accepts the reward for the new category.
    const reward = existing.type === "lost" && categoryChanged ? rewardAcknowledgement(input, input.category) : null;

    const { images, keys } = await storeImages(files, { storage, uploads: config.uploads });
    let result;
    try {
      result = await withTransaction(pool, async (db) => {
        const item = assertOwner(await loadItem(db, id, { forUpdate: true }), req.user);
        const current = await db.query("SELECT id, storage_key, thumb_key FROM item_images WHERE item_id = $1", [id]);
        const removeIds = new Set(input.removeImageIds || []);
        const removing = current.rows.filter((image) => removeIds.has(Number(image.id)));
        if (removing.length !== removeIds.size) {
          throw new HttpError(400, "Some images to remove do not belong to this listing", "invalid_image_reference");
        }
        if (current.rows.length - removing.length + images.length > config.uploads.maxFiles) {
          throw new HttpError(400, `A listing can have at most ${config.uploads.maxFiles} images`, "too_many_images");
        }

        const columns = {
          type: input.type,
          name: input.title,
          category: input.category,
          description: input.description === undefined ? undefined : input.description || null,
          location: input.location,
          date: input.date,
          ownership_question: input.ownershipQuestion === undefined ? undefined : input.ownershipQuestion || null,
          category_confirmed: categoryChanged ? true : undefined,
          reward_paise: reward ? reward.rewardPaise : undefined,
          reward_pricing_version: reward ? reward.pricingVersion : undefined,
          reward_terms_version: reward ? reward.termsVersion : undefined,
          moderation_state: flagged ? "pending" : undefined,
          ...(place || {}),
        };
        const sets = [];
        const params = [];
        for (const [column, value] of Object.entries(columns)) {
          if (value === undefined) continue;
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        }
        if (reward) sets.push("reward_accepted_at = now()");
        if (sets.length) {
          params.push(id);
          await db.query(`UPDATE items SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
        } else if (removing.length || images.length) {
          await db.query("UPDATE items SET updated_at = now() WHERE id = $1", [id]);
        }

        if (removing.length) {
          await db.query("DELETE FROM item_images WHERE id = ANY($1)", [removing.map((image) => image.id)]);
        }
        const { rows: maxRow } = await db.query(
          "SELECT COALESCE(max(position), -1) AS p FROM item_images WHERE item_id = $1",
          [id]
        );
        for (const [index, image] of images.entries()) {
          await db.query(
            `INSERT INTO item_images (item_id, storage_key, thumb_key, width, height, position)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, image.storageKey, image.thumbKey, image.width, image.height, maxRow[0].p + 1 + index]
          );
        }
        const updated = await loadItem(db, id, { forUpdate: true });
        const notifications = item.status === "open" ? await notifyMatches(db, notifier, updated) : [];
        return { removing, notifications };
      });
    } catch (error) {
      await storage.remove(keys).catch(() => {});
      throw error;
    }

    // Only after commit: delete replaced objects and purge CDN copies.
    if (result.removing.length) {
      await storage.remove(result.removing.flatMap((image) => [image.storage_key, image.thumb_key])).catch(() => {});
      await storage.invalidate(imagePaths(result.removing.map((image) => image.id)));
    }
    await notifier.deliver(result.notifications);
    res.json({ item: await serializeOne(pool, await loadItem(pool, id), req.user) });
  });

  router.delete("/items/:id", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const removed = await withTransaction(pool, async (db) => {
      assertOwner(await loadItem(db, id, { forUpdate: true }), req.user);
      const { rows: images } = await db.query("DELETE FROM item_images WHERE item_id = $1 RETURNING id, storage_key, thumb_key", [id]);
      await db.query("UPDATE items SET deleted_at = now(), updated_at = now() WHERE id = $1", [id]);
      await db.query("UPDATE claims SET status = 'superseded', updated_at = now() WHERE item_id = $1 AND status = 'pending'", [id]);
      return images;
    });
    await storage.remove(removed.flatMap((image) => [image.storage_key, image.thumb_key])).catch(() => {});
    await storage.invalidate(imagePaths(removed.map((image) => image.id)));
    res.status(204).end();
  });

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------
  router.post("/items/:id/status", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const { status } = z.object({ status: z.enum(["open", "returned", "closed"]) }).parse(req.body || {});
    if (status === "returned") {
      throw new HttpError(409, "A return is completed by the owner confirming receipt, or with “I found it myself” / “Returned outside the platform”.", "invalid_transition", {
        from: null,
        allowed: [],
      });
    }

    const outcome = await withTransaction(pool, async (db) => {
      // Lock this listing plus any listing tied to it by an accepted match (id order).
      const locked = await returns.lockListing(db, id);
      const item = assertOwner(locked.item, req.user);
      if (item.moderation_state === "removed") throw new HttpError(409, "This listing was removed by a moderator", "item_removed");
      if (item.status === status) return { item, notifications: [], changed: false };
      if (item.status === "closed" && status === "open" && item.closure_reason && item.closure_reason !== "closed_by_reporter") {
        throw new HttpError(409, "This listing was closed as recovered. Request a correction to reopen it.", "correction_required");
      }
      if (!TRANSITIONS[item.status].includes(status)) {
        throw new HttpError(409, `A ${item.status} listing cannot be marked ${status}`, "invalid_transition", {
          from: item.status,
          allowed: TRANSITIONS[item.status],
        });
      }

      const notifications = [];
      const touched = [];
      if (status === "open" || status === "closed") {
        // Reopening/closing a claimed listing cancels its accepted match (on
        // this listing or where it is the claimant's linked listing) and
        // releases the other listing. Payments are untouched.
        for (const claim of locked.claims) {
          const { rows } = await db.query(
            `UPDATE claims SET status = 'revoked', close_reason = 'match_cancelled_by_poster', decided_at = now(), updated_at = now()
             WHERE id = $1 RETURNING id, claimant_id, owner_id, finder_id, status`,
            [claim.id]
          );
          const otherId = claim.item_id === id ? claim.linked_item_id : claim.item_id;
          if (otherId) await db.query("UPDATE items SET status = 'open', status_changed_at = now(), updated_at = now() WHERE id = $1 AND status = 'claimed'", [otherId]);
          await returns.event(db, { event: "match_cancelled", claimId: claim.id, itemId: id, actorId: req.user.id, note: `listing_${status}` });
          const counterpart = rows[0].owner_id === req.user.id ? rows[0].finder_id : rows[0].owner_id;
          touched.push({ ...rows[0], claimant_id: counterpart });
        }
      }
      if (status === "closed") {
        const { rows } = await db.query(
          `UPDATE claims SET status = 'superseded', close_reason = 'listing_closed', decided_at = now(), updated_at = now()
           WHERE item_id = $1 AND status = 'pending' RETURNING id, claimant_id, status`,
          [id]
        );
        touched.push(...rows);
      }
      for (const claim of touched) {
        notifications.push(
          await notifier.notify(db, {
            userId: claim.claimant_id,
            type: "claim_update",
            itemId: id,
            data: { claimId: Number(claim.id), status: claim.status },
            dedupeKey: `claim:${claim.id}:${claim.status}`,
          })
        );
      }

      const { rows } = await db.query(
        "UPDATE items SET status = $1, closure_reason = $3, status_changed_at = now(), updated_at = now() WHERE id = $2 RETURNING *",
        [status, id, status === "closed" ? "closed_by_reporter" : null]
      );
      if (status === "open") notifications.push(...(await notifyMatches(db, notifier, rows[0])));
      return { item: rows[0], notifications, changed: true };
    });

    await notifier.deliver(outcome.notifications);
    res.json({ item: await serializeOne(pool, await loadItem(pool, id), req.user), changed: outcome.changed });
  });

  // ---------------------------------------------------------------------
  // Return lifecycle on the listing
  // ---------------------------------------------------------------------
  // What closing would affect: shown in the confirmation dialog first.
  router.get("/items/:id/lifecycle", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const item = assertOwner(await loadItem(pool, id), req.user);
    res.set("Cache-Control", "private, no-store").json(await returns.closurePreview(req.user, item));
  });

  const closeBody = z.object({ confirm: z.literal(true, { error: "Please confirm" }), note: z.string().trim().max(1000).optional() }).strict();
  for (const [path, kind] of [
    ["self-recovered", "self_recovered"],
    ["returned-externally", "external"],
  ]) {
    router.post(`/items/:id/${path}`, requireUser, async (req, res) => {
      const id = parseId(req.params.id, "Item ID");
      const { note } = closeBody.parse(req.body || {});
      const result = await returns.closeWithRecovery(req.user, id, kind, note);
      res.json({
        item: await serializeOne(pool, await loadItem(pool, id), req.user),
        changed: result.changed,
        // Money is resolved separately: paid connections stay on record and
        // the owner can still request a refund through support.
        paidConnections: result.paidConnections,
      });
    });
  }

  router.post("/items/:id/correction-request", requireUser, limits.abuse, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const { reason } = z.object({ reason: z.string().trim().min(10, "Tell us what happened (at least 10 characters)").max(1000) }).strict().parse(req.body || {});
    const result = await returns.requestCorrection(req.user, id, reason);
    res.status(result.changed ? 201 : 200).json({ ok: true, alreadyRequested: !result.changed });
  });

  // Account history: every completed return the user took part in.
  router.get("/me/returns", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.*, li.name AS lost_title, fi.name AS found_title, c.reward_status, c.reward_status_at, c.reward_paise,
              c.handover_at, c.return_confirmed_at, conv.id AS conversation_id,
              p.id AS payment_id, p.provider_order_id, p.amount_paise, p.currency, p.status AS payment_status, p.paid_at
       FROM recoveries r
       LEFT JOIN items li ON li.id = r.lost_item_id
       LEFT JOIN items fi ON fi.id = r.found_item_id
       LEFT JOIN claims c ON c.id = r.claim_id
       LEFT JOIN conversations conv ON conv.item_id = c.item_id AND conv.participant_id = c.claimant_id
       LEFT JOIN LATERAL (SELECT * FROM connection_payments p WHERE p.claim_id = r.claim_id AND p.status IN ('paid', 'refund_pending', 'refunded')
                          ORDER BY p.created_at DESC LIMIT 1) p ON TRUE
       WHERE r.owner_id = $1 OR r.finder_id = $1
       ORDER BY r.completed_at DESC, r.id DESC LIMIT 200`,
      [req.user.id]
    );
    res.set("Cache-Control", "private, no-store").json({
      returns: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        role: r.owner_id === req.user.id ? "owner" : "finder",
        completedAt: timestamp(r.completed_at),
        corrected: Boolean(r.corrected_at),
        correctedAt: timestamp(r.corrected_at),
        lostItem: r.lost_item_id ? { id: r.lost_item_id, title: r.lost_title } : null,
        foundItem: r.found_item_id ? { id: r.found_item_id, title: r.found_title } : null,
        claimId: r.claim_id ? Number(r.claim_id) : null,
        conversationId: r.conversation_id ? Number(r.conversation_id) : null,
        handoverAt: timestamp(r.handover_at),
        receiptConfirmedAt: timestamp(r.return_confirmed_at),
        reward: r.claim_id ? { status: r.reward_status, at: timestamp(r.reward_status_at), amountPaise: r.reward_paise } : null,
        payment: r.payment_id
          ? { orderId: r.provider_order_id, amountPaise: r.amount_paise, currency: r.currency, status: r.payment_status, paidAt: timestamp(r.paid_at) }
          : null,
      })),
    });
  });

  // Legacy listings: the poster confirms the category (and, for lost items,
  // accepts the reward) before any new paid connection can start.
  router.post("/items/:id/confirm-category", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const input = z
      .object({
        category: z.enum(CATEGORIES),
        acceptRewardTerms: z.boolean().optional(),
        expectedRewardPaise: z.number().int().positive().optional(),
      })
      .strict()
      .parse(req.body || {});
    await withTransaction(pool, async (db) => {
      const item = assertOwner(await loadItem(db, id, { forUpdate: true }), req.user);
      if (item.status !== "open" && input.category !== item.category) {
        throw new HttpError(409, "The category can't change while a match is in progress", "category_locked");
      }
      const reward = item.type === "lost" ? rewardAcknowledgement(input, input.category) : null;
      await db.query(
        `UPDATE items SET category = $2, category_confirmed = TRUE,
                reward_paise = COALESCE($3, reward_paise), reward_pricing_version = COALESCE($4, reward_pricing_version),
                reward_terms_version = COALESCE($5, reward_terms_version),
                reward_accepted_at = CASE WHEN $3::int IS NULL THEN reward_accepted_at ELSE now() END, updated_at = now()
         WHERE id = $1`,
        [id, input.category, reward?.rewardPaise ?? null, reward?.pricingVersion ?? null, reward?.termsVersion ?? null]
      );
    });
    res.json({ item: await serializeOne(pool, await loadItem(pool, id), req.user) });
  });

  router.get("/items/:id/matches", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    assertOwner(await loadItem(pool, id), req.user);
    const matches = await findMatches(pool, id, 10);
    if (matches.length === 0) return res.json({ matches: [] });
    const { rows } = await pool.query(`${ITEM_SELECT} WHERE i.id = ANY($1)`, [matches.map((m) => m.id)]);
    const images = await imagesFor(pool, rows.map((row) => row.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    res.json({
      matches: matches
        .filter((match) => byId.has(match.id))
        .map((match) => ({
          score: Math.round(Number(match.score) * 100) / 100,
          item: publicItem(byId.get(match.id), images.get(match.id) || []),
        })),
    });
  });

  // ---------------------------------------------------------------------
  // Abuse reports
  // ---------------------------------------------------------------------
  router.post("/items/:id/reports", requireUser, limits.abuse, async (req, res) => {
    const id = parseId(req.params.id, "Item ID");
    const { reason, details } = z
      .object({
        reason: z.enum(["spam", "scam", "inappropriate", "personal_info", "duplicate", "other"]),
        details: z.string().trim().max(1000).optional(),
      })
      .strict()
      .parse(req.body || {});
    const item = assertVisible(await loadItem(pool, id), req.user);
    if (item.user_id === req.user.id) throw new HttpError(400, "You cannot report your own listing", "own_listing");

    const { rows } = await pool.query(
      `INSERT INTO listing_reports (item_id, reporter_id, reason, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id, reporter_id) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [id, req.user.id, reason, details || null]
    );
    res.status(rows[0] ? 201 : 200).json({ ok: true, alreadyReported: !rows[0] });
  });

  return router;
}

module.exports = { itemRoutes };
