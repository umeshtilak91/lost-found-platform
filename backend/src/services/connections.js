"use strict";

// Paid connection core: ₹100 checkout for an accepted owner–finder match,
// payment confirmation (browser callback, webhook, reconciliation), and the
// resulting communication entitlement. Every state change happens inside a
// transaction that locks the payment row, so retries, duplicate webhooks and
// concurrent callbacks converge on one effective entitlement.

const { withTransaction } = require("../db");
const { HttpError } = require("../middleware/errors");
const { CONNECTION_FEE_PAISE, CURRENCY, PRICING_VERSION } = require("../config/pricing");

function isUnlocked(conversation) {
  return Boolean(conversation && conversation.unlocked_at);
}

function createConnectionService({ pool, provider, notifier, logger }) {
  // ---------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------
  async function loadClaimForCheckout(db, claimId, user, { forUpdate = false } = {}) {
    const { rows } = await db.query(`SELECT * FROM claims WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [claimId]);
    const claim = rows[0];
    if (!claim || (claim.owner_id !== user.id && claim.finder_id !== user.id)) throw new HttpError(404, "Match not found", "claim_not_found");
    if (claim.owner_id !== user.id) throw new HttpError(403, "Only the owner pays the connection fee", "not_owner");
    if (claim.status !== "accepted") throw new HttpError(409, "This match has not been accepted", "match_not_accepted");
    const item = await db.query("SELECT status FROM items WHERE id = $1", [claim.item_id]);
    if (item.rows[0]?.status !== "claimed") throw new HttpError(409, "This listing is closed, so no new connection can start", "item_closed");
    if (!claim.owner_accepted_at || !claim.reward_paise || claim.fee_paise !== CONNECTION_FEE_PAISE || claim.currency !== CURRENCY) {
      throw new HttpError(409, "The reward agreement must be accepted before paying", "terms_required");
    }
    return claim;
  }

  async function startCheckout(claimId, user) {
    // Validate and reuse an open order inside a transaction (one open order per match).
    const existing = await withTransaction(pool, async (db) => {
      const claim = await loadClaimForCheckout(db, claimId, user, { forUpdate: true });
      const paid = await db.query("SELECT 1 FROM connection_payments WHERE claim_id = $1 AND status IN ('paid', 'refund_pending')", [claimId]);
      if (paid.rowCount) throw new HttpError(409, "The connection fee for this match is already paid", "already_paid");
      const conversation = await db.query("SELECT unlocked_at FROM conversations WHERE item_id = $1 AND participant_id = $2", [claim.item_id, claim.claimant_id]);
      if (isUnlocked(conversation.rows[0])) throw new HttpError(409, "This conversation is already unlocked", "already_unlocked");
      const open = await db.query("SELECT * FROM connection_payments WHERE claim_id = $1 AND status IN ('created', 'pending')", [claimId]);
      return { claim, open: open.rows[0] || null };
    });

    let payment = existing.open;
    if (!payment) {
      const order = await provider.createOrder({
        amount: CONNECTION_FEE_PAISE,
        currency: CURRENCY,
        receipt: `claim-${claimId}`,
        notes: { claim_id: String(claimId), purpose: "connection_fee", pricing_version: PRICING_VERSION },
      });
      if (order.amount !== CONNECTION_FEE_PAISE || order.currency !== CURRENCY) throw new HttpError(502, "Payment provider returned an unexpected order", "provider_mismatch");
      try {
        const { rows } = await pool.query(
          `INSERT INTO connection_payments (claim_id, owner_id, provider, provider_order_id, amount_paise, currency)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [claimId, user.id, provider.name, order.id, CONNECTION_FEE_PAISE, CURRENCY]
        );
        payment = rows[0];
      } catch (error) {
        // A concurrent request created the open order first: use that one.
        if (error.code !== "23505") throw error;
        const { rows } = await pool.query("SELECT * FROM connection_payments WHERE claim_id = $1 AND status IN ('created', 'pending')", [claimId]);
        payment = rows[0];
      }
    }

    return {
      ...provider.checkoutConfig(),
      orderId: payment.provider_order_id,
      amountPaise: payment.amount_paise,
      currency: payment.currency,
      rewardPaise: existing.claim.reward_paise,
      claimId: Number(claimId),
    };
  }

  // ---------------------------------------------------------------------
  // Applying provider truth (shared by callback, webhook and reconciliation)
  // ---------------------------------------------------------------------
  async function applyPayment(orderId, providerPayment, source) {
    let notifications = [];
    const result = await withTransaction(pool, async (db) => {
      const { rows } = await db.query("SELECT * FROM connection_payments WHERE provider_order_id = $1 FOR UPDATE", [orderId]);
      const payment = rows[0];
      if (!payment) throw new HttpError(404, "Unknown order", "order_not_found");

      // Authoritative checks: provider record must belong to this order with the exact fee.
      if (providerPayment.order_id !== orderId) throw new HttpError(400, "Payment does not belong to this order", "order_mismatch");
      if (providerPayment.amount !== payment.amount_paise || providerPayment.currency !== payment.currency || payment.amount_paise !== CONNECTION_FEE_PAISE) {
        logger.warn({ orderId, source }, "Payment amount/currency mismatch");
        await db.query("UPDATE connection_payments SET status = 'failed', failure_reason = 'amount_mismatch', updated_at = now() WHERE id = $1 AND status IN ('created','pending')", [payment.id]);
        return { status: "failed", reason: "amount_mismatch" };
      }

      if (["paid", "refund_pending", "refunded"].includes(payment.status)) {
        // Already settled. A late "failed" or duplicate event changes nothing.
        return { status: payment.status, claimId: payment.claim_id };
      }

      if (providerPayment.status === "captured") {
        await db.query(
          `UPDATE connection_payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1`,
          [payment.id, providerPayment.id]
        );
        notifications = await grantEntitlement(db, payment, providerPayment.id);
        return { status: "paid", claimId: payment.claim_id };
      }
      if (providerPayment.status === "authorized") {
        await db.query("UPDATE connection_payments SET status = 'pending', provider_payment_id = $2, updated_at = now() WHERE id = $1", [payment.id, providerPayment.id]);
        return { status: "pending", claimId: payment.claim_id, needsCapture: true };
      }
      if (providerPayment.status === "failed") {
        await db.query("UPDATE connection_payments SET status = 'failed', failure_reason = 'provider_failed', updated_at = now() WHERE id = $1", [payment.id]);
        return { status: "failed", claimId: payment.claim_id };
      }
      return { status: payment.status, claimId: payment.claim_id };
    });

    if (result.needsCapture) {
      try {
        const captured = await provider.capture(providerPayment.id, CONNECTION_FEE_PAISE, CURRENCY);
        return applyPayment(orderId, captured, `${source}:capture`);
      } catch (error) {
        logger.warn({ err: { message: error.message }, orderId }, "Capture failed; payment stays pending");
      }
    }
    await notifier.deliver(notifications);
    return result;
  }

  async function grantEntitlement(db, payment, providerPaymentId) {
    const { rows } = await db.query("SELECT * FROM claims WHERE id = $1 FOR UPDATE", [payment.claim_id]);
    const claim = rows[0];
    // The listing was closed (match cancelled) while the payment was in
    // flight: keep the payment on record, unlock nothing, and open a refund
    // request for support so the owner isn't charged for a dead match.
    if (!claim || claim.status !== "accepted") {
      logger.warn({ claimId: payment.claim_id, providerPaymentId }, "Payment captured for an inactive match; refund request opened");
      await db.query(
        `INSERT INTO support_requests (kind, claim_id, payment_id, requester_id, message)
         VALUES ('refund', $1, $2, $3, 'Automatic: the match was closed before this connection payment completed.')
         ON CONFLICT (payment_id) WHERE kind = 'refund' AND status = 'open' DO NOTHING`,
        [payment.claim_id, payment.id, payment.owner_id]
      );
      return [];
    }
    const conv = await db.query(
      `UPDATE conversations SET unlocked_at = COALESCE(unlocked_at, now()), unlock_source = COALESCE(unlock_source, 'payment'), unlock_claim_id = $3, locked_reason = NULL
       WHERE item_id = $1 AND participant_id = $2 RETURNING id`,
      [claim.item_id, claim.claimant_id, claim.id]
    );
    const conversationId = conv.rows[0].id;
    const inserted = await db.query(
      `INSERT INTO connection_entitlements (claim_id, conversation_id, payment_id) VALUES ($1, $2, $3)
       ON CONFLICT (claim_id) DO UPDATE SET payment_id = EXCLUDED.payment_id, conversation_id = EXCLUDED.conversation_id,
         granted_at = now(), revoked_at = NULL, revoke_reason = NULL
       WHERE connection_entitlements.revoked_at IS NOT NULL
       RETURNING id`,
      [claim.id, conversationId, payment.id]
    );
    if (!inserted.rowCount) return [];
    logger.info({ claimId: claim.id, providerPaymentId }, "Connection unlocked");
    const data = { claimId: Number(claim.id), conversationId: Number(conversationId) };
    return [
      await notifier.notify(db, { userId: claim.owner_id, type: "connection_unlocked", itemId: claim.item_id, data, dedupeKey: `unlock:${claim.id}` }),
      await notifier.notify(db, { userId: claim.finder_id, type: "connection_unlocked", itemId: claim.item_id, data, dedupeKey: `unlock:${claim.id}` }),
    ];
  }

  // Browser callback after checkout: signature first, then provider truth.
  async function confirmFromCheckout(user, { orderId, paymentId, signature }) {
    const { rows } = await pool.query("SELECT * FROM connection_payments WHERE provider_order_id = $1", [orderId]);
    const payment = rows[0];
    if (!payment || payment.owner_id !== user.id) throw new HttpError(404, "Unknown order", "order_not_found");
    if (!provider.verifyCheckoutSignature(orderId, paymentId, signature)) {
      throw new HttpError(400, "Payment signature is invalid", "invalid_signature");
    }
    const providerPayment = await provider.fetchPayment(paymentId);
    return applyPayment(orderId, providerPayment, "checkout");
  }

  async function cancelCheckout(user, orderId) {
    const { rowCount } = await pool.query(
      "UPDATE connection_payments SET status = 'cancelled', updated_at = now() WHERE provider_order_id = $1 AND owner_id = $2 AND status = 'created'",
      [orderId, user.id]
    );
    return { cancelled: rowCount === 1 };
  }

  // ---------------------------------------------------------------------
  // Webhooks (raw body, signature verified, deduplicated by event id)
  // ---------------------------------------------------------------------
  async function handleWebhook(rawBody, signature, eventIdHeader) {
    if (!provider.verifyWebhookSignature(rawBody, signature)) throw new HttpError(400, "Invalid webhook signature", "invalid_signature");
    const event = JSON.parse(rawBody.toString("utf8"));
    const eventId = eventIdHeader || `${event.event}:${event.payload?.payment?.entity?.id || event.payload?.refund?.entity?.id || event.created_at}`;
    const paymentEntity = event.payload?.payment?.entity;
    const refundEntity = event.payload?.refund?.entity;
    const orderId = paymentEntity?.order_id || event.payload?.order?.entity?.id || null;

    const fresh = await pool.query(
      "INSERT INTO payment_events (provider, event_id, event_type, order_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING event_id",
      [provider.name, eventId, event.event, orderId]
    );
    if (!fresh.rowCount) return { duplicate: true };

    try {
      if (["payment.captured", "payment.authorized", "payment.failed", "order.paid"].includes(event.event) && paymentEntity && orderId) {
        // Re-read from the provider rather than trusting the event body alone.
        const providerPayment = await provider.fetchPayment(paymentEntity.id).catch(() => paymentEntity);
        await applyPayment(orderId, providerPayment, `webhook:${event.event}`);
      } else if (["refund.processed", "payment.refunded"].includes(event.event)) {
        const paymentId = refundEntity?.payment_id || paymentEntity?.id;
        if (paymentId) await markRefunded(paymentId, refundEntity?.id || null, "webhook");
      }
    } catch (error) {
      // Allow the provider to retry: forget this event id.
      await pool.query("DELETE FROM payment_events WHERE provider = $1 AND event_id = $2", [provider.name, eventId]);
      throw error;
    }
    return { processed: true };
  }

  // ---------------------------------------------------------------------
  // Reconciliation (browser closed after paying, missed webhooks)
  // ---------------------------------------------------------------------
  async function reconcileClaim(claimId) {
    const { rows } = await pool.query(
      "SELECT provider_order_id FROM connection_payments WHERE claim_id = $1 AND status IN ('created', 'pending', 'cancelled', 'failed') ORDER BY created_at DESC LIMIT 3",
      [claimId]
    );
    for (const row of rows) {
      let payments = [];
      try {
        payments = await provider.listOrderPayments(row.provider_order_id);
      } catch (error) {
        logger.warn({ err: { message: error.message } }, "Reconciliation lookup failed");
        continue;
      }
      const best = payments.find((p) => p.status === "captured") || payments.find((p) => p.status === "authorized");
      if (best) await applyPayment(row.provider_order_id, best, "reconcile");
    }
  }

  async function paymentState(claimId) {
    const { rows } = await pool.query(
      "SELECT status, amount_paise, currency, paid_at, refunded_at, created_at FROM connection_payments WHERE claim_id = $1 ORDER BY created_at DESC",
      [claimId]
    );
    const settled = rows.find((r) => ["paid", "refund_pending", "refunded"].includes(r.status));
    return { latest: rows[0] || null, settled: settled || null };
  }

  // ---------------------------------------------------------------------
  // Refunds (moderator-approved). Refunding ends the paid connection.
  // ---------------------------------------------------------------------
  async function refundPayment(paymentRowId) {
    const { rows } = await pool.query("SELECT * FROM connection_payments WHERE id = $1", [paymentRowId]);
    const payment = rows[0];
    if (!payment || !["paid", "refund_pending"].includes(payment.status)) throw new HttpError(409, "Only a paid connection can be refunded", "not_refundable");
    await pool.query("UPDATE connection_payments SET status = 'refund_pending', updated_at = now() WHERE id = $1 AND status = 'paid'", [payment.id]);
    const refund = await provider.refund(payment.provider_payment_id, payment.amount_paise);
    await pool.query("UPDATE connection_payments SET provider_refund_id = $2 WHERE id = $1", [payment.id, refund.id]);
    // An approved refund ends the paid connection immediately, even while the
    // provider is still processing the money movement ("pending").
    await withTransaction(pool, (db) => revokeAccess(db, payment.id, "refund_initiated"));
    if (refund.status === "processed") await markRefunded(payment.provider_payment_id, refund.id, "api");
    return { status: refund.status === "processed" ? "refunded" : "refund_pending", refundId: refund.id };
  }

  async function revokeAccess(db, paymentRowId, reason) {
    const ent = await db.query(
      "UPDATE connection_entitlements SET revoked_at = now(), revoke_reason = $2 WHERE payment_id = $1 AND revoked_at IS NULL RETURNING conversation_id",
      [paymentRowId, reason]
    );
    for (const row of ent.rows) {
      await db.query("UPDATE conversations SET unlocked_at = NULL, locked_reason = 'refunded' WHERE id = $1 AND unlock_source = 'payment'", [row.conversation_id]);
    }
  }

  // Settles refund_pending -> refunded by asking the provider (covers missed webhooks).
  async function reconcileRefund(claimId) {
    const { rows } = await pool.query(
      "SELECT provider_payment_id, provider_refund_id FROM connection_payments WHERE claim_id = $1 AND status = 'refund_pending' AND provider_refund_id IS NOT NULL",
      [claimId]
    );
    for (const row of rows) {
      try {
        const refund = await provider.fetchRefund(row.provider_payment_id, row.provider_refund_id);
        if (refund.status === "processed") await markRefunded(row.provider_payment_id, row.provider_refund_id, "reconcile");
      } catch (error) {
        logger.warn({ err: { message: error.message } }, "Refund reconciliation failed");
      }
    }
  }

  async function markRefunded(providerPaymentId, refundId, source) {
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query("SELECT * FROM connection_payments WHERE provider_payment_id = $1 FOR UPDATE", [providerPaymentId]);
      const payment = rows[0];
      if (!payment || payment.status === "refunded") return;
      await db.query(
        "UPDATE connection_payments SET status = 'refunded', refunded_at = now(), provider_refund_id = COALESCE($2, provider_refund_id), updated_at = now() WHERE id = $1",
        [payment.id, refundId]
      );
      await revokeAccess(db, payment.id, "refunded");
      logger.info({ paymentId: payment.id, source }, "Connection fee refunded; access revoked");
    });
  }

  return { startCheckout, confirmFromCheckout, cancelCheckout, handleWebhook, reconcileClaim, reconcileRefund, paymentState, refundPayment, applyPayment };
}

module.exports = { createConnectionService, isUnlocked };
