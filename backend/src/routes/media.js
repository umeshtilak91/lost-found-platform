"use strict";

// Image delivery. Files are never served from a static directory: every
// request is checked against the listing's visibility, and responses are
// always WebP with nosniff + a sandboxing CSP, so nothing uploaded can run as
// active content. Removed/deleted listings return 404 for the public.

const express = require("express");
const { isModerator } = require("../services/items");

function mediaRoutes({ pool, storage }) {
  const router = express.Router();

  router.get(["/images/:id", "/images/:id/thumb"], async (req, res) => {
    if (!/^\d{1,15}$/.test(req.params.id)) return res.status(404).end();
    const { rows } = await pool.query(
      `SELECT img.storage_key, img.thumb_key, i.user_id, i.moderation_state, i.deleted_at
       FROM item_images img JOIN items i ON i.id = img.item_id WHERE img.id = $1`,
      [req.params.id]
    );
    const image = rows[0];
    const publicVisible = image && !image.deleted_at && image.moderation_state === "visible";
    const privilegedViewer =
      image && !image.deleted_at && req.user && (req.user.id === image.user_id || isModerator(req.user));
    if (!publicVisible && !privilegedViewer) {
      return res.status(404).set("Cache-Control", "no-store").end();
    }

    const object = await storage.get(req.path.endsWith("/thumb") ? image.thumb_key : image.storage_key);
    if (!object) return res.status(404).set("Cache-Control", "no-store").end();

    res.set({
      "Content-Type": "image/webp",
      "Content-Length": String(object.body.length),
      "Content-Disposition": 'inline; filename="image.webp"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
      // Short public cache so moderation removals take effect quickly even
      // without a CDN purge; private for owner/moderator-only views.
      "Cache-Control": publicVisible ? "public, max-age=300" : "private, no-store",
    });
    return res.send(object.body);
  });

  // Legacy /uploads/* URLs from the prototype are never served directly.
  router.all("/uploads/*path", (req, res) => res.status(410).json({ error: { code: "gone", message: "Moved" } }));

  return router;
}

module.exports = { mediaRoutes };
