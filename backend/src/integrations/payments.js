"use strict";

// Payment providers for the ₹100 connection fee.
//   razorpay: Razorpay Standard Checkout (Orders API + checkout.js), REST via fetch.
//   test:     local adapter that mimics Razorpay's order/payment/signature/webhook
//             contract so the full flow can be exercised without credentials.
// Both expose: createOrder, fetchPayment, listOrderPayments, capture, refund,
// verifyCheckoutSignature, verifyWebhookSignature, checkoutConfig.

const crypto = require("crypto");

function hmacHex(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function createRazorpayProvider({ keyId, keySecret, webhookSecret }) {
  const base = "https://api.razorpay.com/v1";
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  async function call(method, path, body) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Razorpay ${method} ${path} failed: ${data?.error?.description || response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  return {
    name: "razorpay",
    createOrder: ({ amount, currency, receipt, notes }) => call("POST", "/orders", { amount, currency, receipt, notes }),
    fetchPayment: (paymentId) => call("GET", `/payments/${encodeURIComponent(paymentId)}`),
    listOrderPayments: async (orderId) => (await call("GET", `/orders/${encodeURIComponent(orderId)}/payments`)).items || [],
    capture: (paymentId, amount, currency) => call("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency }),
    refund: (paymentId, amount) => call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount }),
    fetchRefund: (paymentId, refundId) => call("GET", `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`),
    verifyCheckoutSignature: (orderId, paymentId, signature) => safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature),
    verifyWebhookSignature: (rawBody, signature) => Boolean(webhookSecret) && safeEqualHex(hmacHex(webhookSecret, rawBody), signature),
    checkoutConfig: () => ({ provider: "razorpay", keyId }),
  };
}

function createTestProvider({ pool, keySecret, webhookSecret }) {
  const id = (prefix) => `${prefix}_test${crypto.randomBytes(9).toString("base64url")}`;
  const orders = {
    async get(orderId) {
      const { rows } = await pool.query("SELECT amount_paise, currency FROM connection_payments WHERE provider_order_id = $1", [orderId]);
      return rows[0];
    },
  };
  return {
    name: "test",
    keySecret,
    webhookSecret,
    async createOrder({ amount, currency }) {
      return { id: id("order"), amount, currency, status: "created" };
    },
    async fetchPayment(paymentId) {
      const { rows } = await pool.query("SELECT * FROM test_provider_payments WHERE payment_id = $1", [paymentId]);
      if (!rows[0]) {
        const error = new Error("Payment not found");
        error.status = 404;
        throw error;
      }
      const p = rows[0];
      return { id: p.payment_id, order_id: p.order_id, amount: p.amount, currency: p.currency, status: p.status };
    },
    async listOrderPayments(orderId) {
      const { rows } = await pool.query("SELECT * FROM test_provider_payments WHERE order_id = $1 ORDER BY created_at", [orderId]);
      return rows.map((p) => ({ id: p.payment_id, order_id: p.order_id, amount: p.amount, currency: p.currency, status: p.status }));
    },
    async capture(paymentId) {
      await pool.query("UPDATE test_provider_payments SET status = 'captured' WHERE payment_id = $1 AND status = 'authorized'", [paymentId]);
      return this.fetchPayment(paymentId);
    },
    async refund(paymentId) {
      await pool.query("UPDATE test_provider_payments SET status = 'refunded' WHERE payment_id = $1", [paymentId]);
      return { id: id("rfnd"), payment_id: paymentId, status: "processed" };
    },
    async fetchRefund(paymentId, refundId) {
      return { id: refundId, payment_id: paymentId, status: "processed" };
    },
    verifyCheckoutSignature: (orderId, paymentId, signature) => safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature),
    verifyWebhookSignature: (rawBody, signature) => safeEqualHex(hmacHex(webhookSecret, rawBody), signature),
    checkoutConfig: () => ({ provider: "test", keyId: "rzp_test_local" }),
    // Simulates the customer completing (or failing) checkout at the provider.
    async simulate(orderId, outcome, { amountOverride } = {}) {
      const order = await orders.get(orderId);
      if (!order) throw new Error("Unknown order");
      const paymentId = id("pay");
      const status = outcome === "success" ? "captured" : outcome === "authorized" ? "authorized" : "failed";
      await pool.query(
        "INSERT INTO test_provider_payments (payment_id, order_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5)",
        [paymentId, orderId, amountOverride ?? order.amount_paise, order.currency, status]
      );
      return { paymentId, signature: hmacHex(keySecret, `${orderId}|${paymentId}`), status };
    },
    signWebhook: (rawBody) => hmacHex(webhookSecret, rawBody),
  };
}

function createPaymentProvider(config, pool) {
  return config.payments.provider === "razorpay"
    ? createRazorpayProvider(config.payments.razorpay)
    : createTestProvider({ pool, keySecret: config.payments.test.keySecret, webhookSecret: config.payments.test.webhookSecret });
}

module.exports = { createPaymentProvider, hmacHex, safeEqualHex };
