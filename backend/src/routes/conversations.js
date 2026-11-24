"use strict";

// Private contact between a listing's reporter and one other user.
// Only the two participants can read or post. New conversations start LOCKED:
// messages, phone sharing and handover details unlock only after the owner
// pays the ₹100 connection fee for the accepted match (or for conversations
// that existed before paid connections, which were grandfathered).
// Phone numbers are never shown unless their owner turns sharing on for that
// single conversation; paying never exposes a number by itself.

const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");
const { requireUser } = require("../middleware/security");
const { displayName, publicItem, timestamp } = require("../services/serializers");
const { loadItem, parseId, assertVisible, imagesFor } = require("../services/items");
const { isUnlocked } = require("../services/connections");
const { returnState } = require("../services/returns");

function assertUnlocked(conversation) {
  if (!isUnlocked(conversation)) {
    throw new HttpError(402, "This conversation unlocks after the owner pays the ₹100 connection fee for an accepted match", "connection_locked");
  }
}

async function ensureConversation(db, item, participantId) {
  const { rows } = await db.query(
    `INSERT INTO conversations (item_id, reporter_id, participant_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (item_id, participant_id) DO UPDATE SET item_id = EXCLUDED.item_id
     RETURNING *`,
    [item.id, item.user_id, participantId]
  );
  return rows[0];
}

const messageSchema = z
  .object({
    body: z.string().trim().min(1, "Message cannot be empty").max(2000),
    clientId: z.string().uuid().optional(),
  })
  .strict();

function conversationRoutes({ pool, notifier, limits }) {
  const router = express.Router();

  async function loadForParticipant(db, id, user, { forUpdate = false } = {}) {
    const { rows } = await db.query(`SELECT * FROM conversations WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [id]);
    const conversation = rows[0];
    // 404 (not 403) so non-participants cannot probe for conversation IDs.
    if (!conversation || (conversation.reporter_id !== user.id && conversation.participant_id !== user.id)) {
      throw new HttpError(404, "Conversation not found", "conversation_not_found");
    }
    return conversation;
  }

  async function postMessage(db, conversation, user, { body, clientId }) {
    const inserted = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body, client_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id, client_id) DO NOTHING RETURNING *`,
      [conversation.id, user.id, body, clientId || crypto.randomUUID()]
    );
    if (!inserted.rows[0]) {
      const existing = await db.query("SELECT * FROM messages WHERE conversation_id = $1 AND client_id = $2", [conversation.id, clientId]);
      return { message: existing.rows[0], notification: null };
    }
    const message = inserted.rows[0];
    const isReporter = conversation.reporter_id === user.id;
    await db.query(
      `UPDATE conversations SET last_message_at = $2, ${isReporter ? "reporter_last_read_at" : "participant_last_read_at"} = $2 WHERE id = $1`,
      [conversation.id, message.created_at]
    );
    const notification = await notifier.notify(db, {
      userId: isReporter ? conversation.participant_id : conversation.reporter_id,
      type: "message",
      itemId: conversation.item_id,
      data: { conversationId: Number(conversation.id) },
      dedupeKey: `message:${message.id}`,
    });
    return { message, notification };
  }

  function serializeMessage(row, userId) {
    return {
      id: Number(row.id),
      body: row.body,
      mine: row.sender_id === userId,
      senderDeleted: row.sender_id === null,
      createdAt: timestamp(row.created_at),
      clientId: row.client_id,
    };
  }

  // Start (or reopen) a private conversation about a listing.
  router.post("/items/:id/conversations", requireUser, limits.contact, async (req, res) => {
    const itemId = parseId(req.params.id, "Item ID");
    const input = z
      .object({ body: z.string().trim().max(2000).optional(), clientId: z.string().uuid().optional() })
      .strict()
      .parse(req.body || {});

    const result = await withTransaction(pool, async (db) => {
      const item = assertVisible(await loadItem(db, itemId), req.user);
      if (item.moderation_state !== "visible") throw new HttpError(410, "This listing is no longer available", "item_removed");
      if (item.user_id === req.user.id) throw new HttpError(400, "This is your own listing", "own_listing");
      if (!item.user_id) throw new HttpError(409, "The person who posted this listing has left", "reporter_gone");
      const conversation = await ensureConversation(db, item, req.user.id);
      let notification = null;
      if (input.body) {
        assertUnlocked(conversation);
        ({ notification } = await postMessage(db, conversation, req.user, input));
      }
      return { conversation, notification };
    });
    await notifier.deliver([result.notification]);
    res.status(201).json({ conversationId: Number(result.conversation.id) });
  });

  router.get("/conversations", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.*, i.name AS item_name, i.type AS item_type, i.status AS item_status,
              i.moderation_state, i.deleted_at,
              other.name AS other_name,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id IS DISTINCT FROM $1
                 AND m.created_at > COALESCE(CASE WHEN c.reporter_id = $1 THEN c.reporter_last_read_at ELSE c.participant_last_read_at END, 'epoch')) AS unread
       FROM conversations c
       JOIN items i ON i.id = c.item_id
       LEFT JOIN users other ON other.id = CASE WHEN c.reporter_id = $1 THEN c.participant_id ELSE c.reporter_id END
       WHERE c.reporter_id = $1 OR c.participant_id = $1
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json({
      conversations: rows.map((row) => ({
        id: Number(row.id),
        item: {
          id: row.item_id,
          title: row.item_name,
          type: row.item_type,
          status: row.item_status,
          available: !row.deleted_at && row.moderation_state === "visible",
        },
        role: row.reporter_id === req.user.id ? "reporter" : "participant",
        locked: !row.unlocked_at,
        counterpart: { displayName: displayName(row.other_name) },
        lastMessage: row.unlocked_at && row.last_body ? row.last_body.slice(0, 140) : null,
        lastMessageAt: timestamp(row.last_message_at),
        unread: row.unread,
      })),
    });
  });

  router.get("/conversations/:id", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Conversation ID");
    const conversation = await loadForParticipant(pool, id, req.user);
    const isReporter = conversation.reporter_id === req.user.id;
    const counterpartId = isReporter ? conversation.participant_id : conversation.reporter_id;

    const unlocked = isUnlocked(conversation);
    const [messages, item, counterpart, claims] = await Promise.all([
      unlocked
        ? pool.query("SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 500", [id])
        : Promise.resolve({ rows: [] }),
      pool.query("SELECT i.*, u.name AS user_name FROM items i LEFT JOIN users u ON u.id = i.user_id WHERE i.id = $1", [conversation.item_id]),
      pool.query("SELECT name, mobile_number FROM users WHERE id = $1", [counterpartId]),
      pool.query(
        `SELECT id, status, answer, created_at, decided_at, owner_id, finder_id, reward_paise, fee_paise, currency, agreement_category,
                pricing_version, owner_accepted_at, return_confirmed_at, reward_status, reward_status_at, reward_issue_note,
                item_id, handover_at, close_reason, linked_item_id,
                (SELECT status FROM connection_payments p WHERE p.claim_id = claims.id ORDER BY
                   CASE WHEN p.status IN ('paid','refund_pending','refunded') THEN 0 ELSE 1 END, p.created_at DESC LIMIT 1) AS payment_status
                , EXISTS (SELECT 1 FROM support_requests s WHERE s.claim_id = claims.id AND s.kind = 'return_issue' AND s.status = 'open') AS return_issue_open
         FROM claims WHERE item_id = $1 AND claimant_id = $2 ORDER BY created_at DESC`,
        [conversation.item_id, conversation.participant_id]
      ),
    ]);
    const itemRow = item.rows[0];
    const images = await imagesFor(pool, [itemRow.id]);
    const counterpartShares = isReporter ? conversation.participant_shares_phone : conversation.reporter_shares_phone;

    await pool.query(
      `UPDATE conversations SET ${isReporter ? "reporter_last_read_at" : "participant_last_read_at"} = now() WHERE id = $1`,
      [id]
    );

    res.set("Cache-Control", "private, no-store").json({
      conversation: {
        id: Number(conversation.id),
        role: isReporter ? "reporter" : "participant",
        item: {
          ...publicItem(itemRow, images.get(itemRow.id) || []),
          available: !itemRow.deleted_at && itemRow.moderation_state === "visible",
        },
        locked: !unlocked,
        lockedReason: unlocked ? null : conversation.locked_reason || "payment_required",
        unlockSource: conversation.unlock_source || null,
        viewerRole: claims.rows[0] ? (claims.rows[0].owner_id === req.user.id ? "owner" : "finder") : null,
        counterpart: {
          displayName: displayName(counterpart.rows[0]?.name),
          phone: unlocked && counterpartShares ? counterpart.rows[0]?.mobile_number || null : null,
        },
        sharingMyPhone: isReporter ? conversation.reporter_shares_phone : conversation.participant_shares_phone,
        messages: messages.rows.map((row) => serializeMessage(row, req.user.id)),
        claims: claims.rows.map((row) => ({
          id: Number(row.id),
          status: row.status,
          answer: row.answer,
          createdAt: timestamp(row.created_at),
          decidedAt: timestamp(row.decided_at),
          agreement: row.owner_accepted_at
            ? { category: row.agreement_category, rewardPaise: row.reward_paise, feePaise: row.fee_paise, currency: row.currency, pricingVersion: row.pricing_version }
            : null,
          payment: { status: row.payment_status || "none" },
          returnConfirmedAt: timestamp(row.return_confirmed_at),
          itemId: row.item_id,
          handoverAt: timestamp(row.handover_at),
          returnState: returnState({ ...row, unlocked_at: unlocked ? true : null }),
          returnIssueOpen: Boolean(row.return_issue_open),
          closeReason: row.close_reason || null,
          linkedItemId: row.linked_item_id ?? null,
          reward: { status: row.reward_status, at: timestamp(row.reward_status_at), note: row.reward_issue_note || null },
        })),
      },
    });
  });

  router.post("/conversations/:id/messages", requireUser, limits.contact, async (req, res) => {
    const id = parseId(req.params.id, "Conversation ID");
    const input = messageSchema.parse(req.body || {});
    const result = await withTransaction(pool, async (db) => {
      const conversation = await loadForParticipant(db, id, req.user, { forUpdate: true });
      assertUnlocked(conversation);
      const item = await loadItem(db, conversation.item_id);
      if (!item || item.deleted_at || item.moderation_state !== "visible") {
        throw new HttpError(410, "This listing is no longer available, so the conversation is closed", "item_unavailable");
      }
      return postMessage(db, conversation, req.user, input);
    });
    await notifier.deliver([result.notification]);
    res.status(201).json({ message: serializeMessage(result.message, req.user.id) });
  });

  router.post("/conversations/:id/phone-sharing", requireUser, async (req, res) => {
    const id = parseId(req.params.id, "Conversation ID");
    const { share } = z.object({ share: z.boolean() }).strict().parse(req.body || {});
    const conversation = await loadForParticipant(pool, id, req.user);
    assertUnlocked(conversation);
    if (share && !req.user.mobile_number) {
      throw new HttpError(400, "Add a phone number in your account settings first", "no_phone");
    }
    const column = conversation.reporter_id === req.user.id ? "reporter_shares_phone" : "participant_shares_phone";
    await pool.query(`UPDATE conversations SET ${column} = $1 WHERE id = $2`, [share, id]);
    res.json({ sharingMyPhone: share });
  });

  return router;
}

module.exports = { conversationRoutes, ensureConversation };
