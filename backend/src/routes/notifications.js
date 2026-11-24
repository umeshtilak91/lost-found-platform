"use strict";

const express = require("express");
const { z } = require("zod");
const { requireUser } = require("../middleware/security");
const { timestamp } = require("../services/serializers");

function notificationRoutes({ pool }) {
  const router = express.Router();

  router.get("/notifications", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT n.*, i.name AS item_name,
              (i.id IS NOT NULL AND i.deleted_at IS NULL AND (i.moderation_state = 'visible' OR i.user_id = $1)) AS item_available
       FROM notifications n LEFT JOIN items i ON i.id = n.item_id
       WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 100`,
      [req.user.id]
    );
    const unread = rows.filter((row) => !row.read_at).length;
    res.set("Cache-Control", "private, no-store").json({
      unread,
      notifications: rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        itemId: row.item_available ? row.item_id : null,
        itemTitle: row.item_available ? row.item_name : null,
        data: row.data,
        read: Boolean(row.read_at),
        createdAt: timestamp(row.created_at),
      })),
    });
  });

  router.get("/notifications/unread-count", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS notifications,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE (c.reporter_id = $1 OR c.participant_id = $1) AND m.sender_id IS DISTINCT FROM $1
             AND m.created_at > COALESCE(CASE WHEN c.reporter_id = $1 THEN c.reporter_last_read_at ELSE c.participant_last_read_at END, 'epoch')
         ) AS messages`,
      [req.user.id]
    );
    res.set("Cache-Control", "private, no-store").json(rows[0]);
  });

  router.post("/notifications/read", requireUser, async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).strict().parse(req.body || {});
    if (ids?.length) {
      await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL", [req.user.id, ids]);
    } else {
      await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { notificationRoutes };
