"use strict";

const express = require("express");
const { z } = require("zod");
const { HttpError } = require("../middleware/errors");
const { requireUser } = require("../middleware/security");
const { parseId } = require("../services/items");

// Mounted BEFORE express.json(): the webhook needs the exact raw body bytes.
function paymentWebhookRoutes({ connections, provider }) {
  const router = express.Router();
  router.post("/payments/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const signature = req.get("x-razorpay-signature") || "";
    const result = await connections.handleWebhook(req.body, signature, req.get("x-razorpay-event-id"));
    res.json({ ok: true, ...result, provider: provider.name });
  });
  return router;
}

function paymentRoutes({ connections, provider, config, limits }) {
  const router = express.Router();

  // Owner starts (or resumes) checkout for an accepted match. The client only
  // sends the match id; amount and currency are fixed server-side.
  router.post("/claims/:id/checkout", requireUser, limits.claim, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    res.json({ checkout: await connections.startCheckout(claimId, req.user) });
  });

  router.post("/payments/verify", requireUser, async (req, res) => {
    const input = z
      .object({ orderId: z.string().min(5).max(100), paymentId: z.string().min(5).max(100), signature: z.string().min(10).max(200) })
      .strict()
      .parse(req.body || {});
    res.json(await connections.confirmFromCheckout(req.user, input));
  });

  router.post("/payments/:orderId/cancel", requireUser, async (req, res) => {
    res.json(await connections.cancelCheckout(req.user, String(req.params.orderId).slice(0, 100)));
  });

  // Status for the match (reconciles with the provider when not yet settled,
  // e.g. the browser closed right after paying).
  router.get("/claims/:id/payment", requireUser, async (req, res) => {
    const claimId = parseId(req.params.id, "Match ID");
    const { rows } = await req.app.locals.pool.query("SELECT owner_id, finder_id FROM claims WHERE id = $1", [claimId]);
    if (!rows[0] || (rows[0].owner_id !== req.user.id && rows[0].finder_id !== req.user.id)) throw new HttpError(404, "Match not found", "claim_not_found");
    let state = await connections.paymentState(claimId);
    if (!state.settled && state.latest) {
      await connections.reconcileClaim(claimId);
      state = await connections.paymentState(claimId);
    } else if (state.settled?.status === "refund_pending") {
      await connections.reconcileRefund(claimId);
      state = await connections.paymentState(claimId);
    }
    res.set("Cache-Control", "private, no-store").json({
      status: state.settled?.status || state.latest?.status || "none",
      amountPaise: (state.settled || state.latest)?.amount_paise ?? null,
      currency: (state.settled || state.latest)?.currency ?? "INR",
      paidAt: state.settled?.paid_at ?? null,
    });
  });

  // Local test-mode provider only: simulate the customer finishing checkout.
  if (provider.name === "test") {
    router.post("/payments/test/complete", requireUser, async (req, res) => {
      const { orderId, outcome } = z
        .object({ orderId: z.string().max(100), outcome: z.enum(["success", "failure", "authorized"]) })
        .strict()
        .parse(req.body || {});
      const { rows } = await req.app.locals.pool.query("SELECT owner_id FROM connection_payments WHERE provider_order_id = $1", [orderId]);
      if (!rows[0] || rows[0].owner_id !== req.user.id) throw new HttpError(404, "Unknown order", "order_not_found");
      const simulated = await provider.simulate(orderId, outcome === "failure" ? "failed" : outcome);
      res.json({ orderId, paymentId: simulated.paymentId, signature: simulated.signature, status: simulated.status, testMode: true });
    });
  }

  router.get("/payments/config", (req, res) => {
    const keyId = provider.checkoutConfig().keyId;
    res.json({ provider: provider.name, testMode: provider.name === "test" || keyId.startsWith("rzp_test_"), keyId, appName: "Lost & Found", currency: "INR", appUrl: config.appUrl });
  });

  return router;
}

module.exports = { paymentRoutes, paymentWebhookRoutes };
