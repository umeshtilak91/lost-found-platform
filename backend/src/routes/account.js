"use strict";

// Account settings, data export and deletion.
//
// Deletion (see docs/data-retention.md):
// - the user's listings, their images (objects removed from storage), claims,
//   every conversation they took part in (and its messages), notifications,
//   sign-in identities and sessions are deleted
// - abuse reports they filed and moderator audit rows are kept without the
//   link to their account (reporter/moderator set to NULL)

const express = require("express");
const { z } = require("zod");
const { parsePhoneNumberFromString } = require("libphonenumber-js/max");
const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");
const { requireUser } = require("../middleware/security");
const { imagePaths } = require("../services/images");
const { selfUser, timestamp } = require("../services/serializers");
const { loadUser } = require("../auth/accounts");

function accountRoutes({ pool, config, storage }) {
  const router = express.Router();

  router.patch("/account/profile", requireUser, async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        phone: z.string().trim().max(32).nullable().optional(),
        phoneCountry: z.string().trim().length(2).toUpperCase().optional(),
        locale: z.enum(["en", "hi"]).optional(),
      })
      .strict()
      .parse(req.body || {});

    let phone;
    if (input.phone === null || input.phone === "") {
      phone = null;
    } else if (input.phone !== undefined) {
      const parsed = parsePhoneNumberFromString(input.phone, input.phoneCountry || "IN");
      if (!parsed || !parsed.isValid()) {
        throw new HttpError(400, "Enter a valid phone number for the selected country", "invalid_phone");
      }
      phone = parsed.number; // E.164
    }

    const sets = [];
    const params = [];
    for (const [column, value] of [["name", input.name], ["mobile_number", phone], ["locale", input.locale]]) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (phone === null) {
      // Removing the number also stops sharing it anywhere.
      await pool.query(
        `UPDATE conversations SET reporter_shares_phone = CASE WHEN reporter_id = $1 THEN FALSE ELSE reporter_shares_phone END,
                                 participant_shares_phone = CASE WHEN participant_id = $1 THEN FALSE ELSE participant_shares_phone END
         WHERE reporter_id = $1 OR participant_id = $1`,
        [req.user.id]
      );
    }
    if (sets.length) {
      params.push(req.user.id);
      await pool.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    }
    res.json({ user: selfUser(await loadUser(pool, req.user.id)) });
  });

  router.get("/account/export", requireUser, async (req, res) => {
    const id = req.user.id;
    const q = (sql) => pool.query(sql, [id]).then((r) => r.rows);
    const [user, identities, items, images, claims, conversations, messages, notifications, reports] = await Promise.all([
      q("SELECT id, name, email, email_verified, profile_image, mobile_number, locale, role, created_at FROM users WHERE id = $1"),
      q("SELECT provider, created_at FROM auth_identities WHERE user_id = $1"),
      q(`SELECT id, type, name AS title, category, description, location, date, latitude, longitude, ownership_question,
                status, moderation_state, created_at, updated_at, deleted_at FROM items WHERE user_id = $1`),
      q("SELECT img.id, img.item_id, img.width, img.height, img.created_at FROM item_images img JOIN items i ON i.id = img.item_id WHERE i.user_id = $1"),
      q("SELECT id, item_id, answer, status, created_at, decided_at FROM claims WHERE claimant_id = $1"),
      q(`SELECT id, item_id, CASE WHEN reporter_id = $1 THEN 'reporter' ELSE 'participant' END AS role, created_at
         FROM conversations WHERE reporter_id = $1 OR participant_id = $1`),
      q("SELECT conversation_id, body, created_at FROM messages WHERE sender_id = $1"),
      q("SELECT type, item_id, data, read_at, created_at FROM notifications WHERE user_id = $1"),
      q("SELECT item_id, reason, details, status, created_at FROM listing_reports WHERE reporter_id = $1"),
    ]);
    const payload = {
      exportedAt: timestamp(new Date()),
      notice: "Personal data held by Lost & Found for your account. Images are listed by ID; download them from your listings.",
      account: user[0],
      signInMethods: identities,
      listings: items,
      listingImages: images.map((image) => ({ ...image, url: `${config.appUrl}/api/images/${image.id}` })),
      claimsSubmitted: claims,
      conversations,
      messagesSent: messages,
      notifications,
      listingReportsFiled: reports,
    };
    res
      .set("Content-Disposition", `attachment; filename="lost-found-export-${id}.json"`)
      .set("Cache-Control", "private, no-store")
      .json(payload);
  });

  router.delete("/account", requireUser, async (req, res, next) => {
    z.object({ confirm: z.literal("DELETE", { message: 'Type "DELETE" to confirm' }) }).strict().parse(req.body || {});
    const removed = await withTransaction(pool, async (db) => {
      const { rows: images } = await db.query(
        "SELECT img.id, img.storage_key, img.thumb_key FROM item_images img JOIN items i ON i.id = img.item_id WHERE i.user_id = $1",
        [req.user.id]
      );
      await db.query("DELETE FROM items WHERE user_id = $1", [req.user.id]);
      await db.query("DELETE FROM users WHERE id = $1", [req.user.id]);
      return images;
    });
    await storage.remove(removed.flatMap((image) => [image.storage_key, image.thumb_key])).catch(() => {});
    await storage.invalidate(imagePaths(removed.map((image) => image.id)));
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy(() => {
        res.clearCookie(config.session.cookieName, { path: "/" });
        res.status(204).end();
      });
    });
  });

  return router;
}

module.exports = { accountRoutes };
