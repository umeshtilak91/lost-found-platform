"use strict";

// In-app notifications with deduplication. Each event carries a dedupe key
// (e.g. "message:42", "claim:7:accepted"); the (user_id, dedupe_key) unique
// constraint means retries and concurrent duplicates insert exactly one row,
// and external delivery only runs for the row that was actually inserted.

const SUBJECTS = {
  match: "We found a possible match for your listing",
  message: "You have a new message",
  claim_received: "Someone submitted a claim on your listing",
  claim_update: "Your claim was updated",
  item_status: "A listing you are involved with was updated",
  listing_removed: "Your listing was removed by a moderator",
  listing_restored: "Your listing was restored",
};

function createNotifier({ pool, mailer, config, logger }) {
  async function notify(db, { userId, type, itemId = null, data = {}, dedupeKey }) {
    const { rows } = await db.query(
      `INSERT INTO notifications (user_id, type, item_id, data, dedupe_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [userId, type, itemId, data, dedupeKey]
    );
    return rows[0]?.id ? { id: rows[0].id, userId, type, itemId, data } : null;
  }

  // Called after the surrounding transaction commits, so an email is never
  // sent for a change that rolled back.
  async function deliver(created) {
    for (const notification of created.filter(Boolean)) {
      if (!config.mail.notificationEmails) continue;
      try {
        const { rows } = await pool.query("SELECT email FROM users WHERE id = $1", [notification.userId]);
        if (!rows[0]?.email) continue;
        const link = notification.itemId ? `${config.appUrl}/items/${notification.itemId}` : `${config.appUrl}/notifications`;
        const result = await mailer.send({
          to: rows[0].email,
          subject: SUBJECTS[notification.type] || "Lost & Found update",
          text: `${SUBJECTS[notification.type] || "You have an update"}.\n\nOpen Lost & Found to see details: ${link}\n\nYou are receiving this because you have an account on Lost & Found.`,
          template: notification.type,
        });
        await pool.query(
          `INSERT INTO notification_deliveries (notification_id, channel, status, detail)
           VALUES ($1, 'email', $2, $3) ON CONFLICT (notification_id, channel) DO NOTHING`,
          [notification.id, ["sent", "failed", "skipped"].includes(result.status) ? result.status : "failed", result.messageId || result.error || null]
        );
      } catch (error) {
        logger.error({ err: error, notificationId: notification.id }, "Notification delivery failed");
      }
    }
  }

  return { notify, deliver };
}

module.exports = { createNotifier };
