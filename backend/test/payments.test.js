"use strict";

// Category rewards + ₹100 paid connection. Uses the local test-mode payment
// provider (same order/signature/webhook contract as Razorpay); no live
// Razorpay calls are made here.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { setup, createItem, claimFound, connect, createDatabase, testEnv } = require("./helpers");
const { hmacHex } = require("../src/integrations/payments");
const { CATEGORY_REWARD_PAISE } = require("../src/config/pricing");

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.teardown());

const EXPECTED = { phone: 50000, electronics: 50000, wallet: 30000, bag: 30000, keys: 30000, documents: 30000, jewelry: 50000, clothing: 30000, pet: 50000, other: 35000 };

async function acceptedFoundMatch(label, category = "wallet") {
  const finder = await ctx.agent({ email: `${label}-finder@example.com` });
  const item = await createItem(finder, { type: "found", title: `${label} item`, category });
  const owner = await ctx.agent({ email: `${label}-owner@example.com` });
  const claim = await claimFound(owner, item);
  await finder.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
  return { finder, owner, item, claim };
}

function webhook(body, { secret = ctx.config.payments.test.webhookSecret, eventId } = {}) {
  const raw = JSON.stringify(body);
  return ctx
    .anonymous()
    .post("/api/payments/webhook")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Signature", hmacHex(secret, raw))
    .set("X-Razorpay-Event-Id", eventId || `evt_${Math.random().toString(36).slice(2)}`)
    .send(raw);
}

describe("pricing", () => {
  test("every category has the configured reward; Other is ₹350; fee is ₹100", async () => {
    assert.deepEqual({ ...CATEGORY_REWARD_PAISE }, EXPECTED);
    const res = await ctx.anonymous().get("/api/pricing").expect(200);
    assert.equal(res.body.connectionFeePaise, 10000);
    assert.equal(res.body.currency, "INR");
    assert.deepEqual(Object.fromEntries(res.body.categories.map((c) => [c.category, c.rewardPaise])), EXPECTED);
  });

  test("cards show committed finder rewards for lost listings and category rewards for found ones", async () => {
    const http = await ctx.agent({ email: "cards@example.com" });
    for (const category of Object.keys(EXPECTED)) {
      const lost = await createItem(http, { type: "lost", title: `Lost ${category}`, category });
      const found = await createItem(http, { type: "found", title: `Found ${category}`, category });
      assert.deepEqual(lost.reward, { kind: "finder_reward", amountPaise: EXPECTED[category], currency: "INR" });
      assert.deepEqual(found.reward, { kind: "category_reward", amountPaise: EXPECTED[category], currency: "INR" });
    }
  });

  test("publishing a lost item requires the acknowledgement for the current amount", async () => {
    const http = await ctx.agent({ email: "ack@example.com" });
    const base = () => http.post("/api/items").field("type", "lost").field("title", "Keys").field("category", "keys").field("location", "Pune").field("date", new Date().toISOString().slice(0, 10));
    assert.equal((await base()).status, 400);
    const stale = await base().field("acceptRewardTerms", "true").field("expectedRewardPaise", "50000");
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.details.rewardPaise, 30000);
    assert.equal((await base().field("acceptRewardTerms", "true").field("expectedRewardPaise", "30000")).status, 201);
    // Found items need no owner commitment.
    assert.equal((await http.post("/api/items").field("type", "found").field("title", "Keys").field("category", "keys").field("location", "Pune").field("date", new Date().toISOString().slice(0, 10))).status, 201);
  });
});

describe("checkout and payment states", () => {
  test("the order is always exactly ₹100 INR; client cannot change it", async () => {
    const { owner, claim } = await acceptedFoundMatch("amount", "other");
    const res = await owner.post(`/api/claims/${claim.id}/checkout`).send({ amountPaise: 1, currency: "USD" });
    assert.equal(res.status, 200);
    assert.equal(res.body.checkout.amountPaise, 10000);
    assert.equal(res.body.checkout.currency, "INR");
    assert.equal(res.body.checkout.rewardPaise, 35000);
    const { rows } = await ctx.pool.query("SELECT amount_paise, currency FROM connection_payments WHERE claim_id = $1", [claim.id]);
    assert.deepEqual(rows, [{ amount_paise: 10000, currency: "INR" }]);
  });

  test("checkout requires an accepted match owned by the payer", async () => {
    const finder = await ctx.agent({ email: "pending-finder@example.com" });
    const item = await createItem(finder, { type: "found", title: "Pending wallet", category: "wallet" });
    const owner = await ctx.agent({ email: "pending-owner@example.com" });
    const claim = await claimFound(owner, item);
    const res = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "match_not_accepted");
  });

  test("repeated and concurrent checkout clicks reuse one open order", async () => {
    const { owner, claim } = await acceptedFoundMatch("clicks");
    const results = await Promise.all([1, 2, 3, 4].map(() => owner.post(`/api/claims/${claim.id}/checkout`).send({})));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(new Set(results.map((r) => r.body.checkout.orderId)).size, 1);
  });

  test("invalid signature is rejected and grants nothing", async () => {
    const { owner, claim } = await acceptedFoundMatch("badsig");
    const { body } = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    const done = await owner.post("/api/payments/test/complete").send({ orderId: body.checkout.orderId, outcome: "success" });
    const res = await owner.post("/api/payments/verify").send({ orderId: body.checkout.orderId, paymentId: done.body.paymentId, signature: "0".repeat(64) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid_signature");
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM connection_entitlements WHERE claim_id = $1", [claim.id])).rows[0].n, 0);
  });

  test("failed and cancelled payments keep the conversation locked; a later success unlocks", async () => {
    const { owner, claim } = await acceptedFoundMatch("fail");
    const failed = await connect(owner, claim.id, "failure");
    assert.equal(failed.verify.body.status, "failed");
    assert.equal((await owner.get(`/api/conversations/${claim.conversationId}`)).body.conversation.locked, true);

    const { body } = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    assert.equal((await owner.post(`/api/payments/${body.checkout.orderId}/cancel`).send({})).body.cancelled, true);
    const ok = await connect(owner, claim.id);
    assert.equal(ok.verify.body.status, "paid");
    assert.equal((await owner.get(`/api/conversations/${claim.conversationId}`)).body.conversation.locked, false);
  });

  test("authorized payments are captured before access is granted", async () => {
    const { owner, claim } = await acceptedFoundMatch("authorized");
    const res = await connect(owner, claim.id, "authorized");
    assert.equal(res.verify.body.status, "paid");
  });

  test("a provider payment for the wrong amount never unlocks", async () => {
    const { owner, claim } = await acceptedFoundMatch("wrongamount");
    const { body } = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    const orderId = body.checkout.orderId;
    await ctx.pool.query("INSERT INTO test_provider_payments (payment_id, order_id, amount, currency, status) VALUES ('pay_testwrong', $1, 100, 'INR', 'captured')", [orderId]);
    const res = await owner.post("/api/payments/verify").send({ orderId, paymentId: "pay_testwrong", signature: hmacHex(ctx.config.payments.test.keySecret, `${orderId}|pay_testwrong`) });
    assert.equal(res.body.status, "failed");
    assert.equal((await owner.get(`/api/conversations/${claim.conversationId}`)).body.conversation.locked, true);
  });

  test("browser closed after paying: status endpoint reconciles with the provider", async () => {
    const { owner, finder, claim } = await acceptedFoundMatch("closed");
    const { body } = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    await owner.post("/api/payments/test/complete").send({ orderId: body.checkout.orderId, outcome: "success" });
    // No verify call (tab closed). The finder's view triggers reconciliation.
    const state = await finder.get(`/api/claims/${claim.id}/payment`).expect(200);
    assert.equal(state.body.status, "paid");
    assert.equal((await owner.get(`/api/conversations/${claim.conversationId}`)).body.conversation.locked, false);
  });
});

describe("webhooks", () => {
  test("signed webhook unlocks; duplicates and late failures are ignored; concurrent verify grants once", async () => {
    const { owner, claim } = await acceptedFoundMatch("webhook");
    const { body } = await owner.post(`/api/claims/${claim.id}/checkout`).send({});
    const orderId = body.checkout.orderId;
    const done = await owner.post("/api/payments/test/complete").send({ orderId, outcome: "success" });
    const event = { event: "payment.captured", payload: { payment: { entity: { id: done.body.paymentId, order_id: orderId, amount: 10000, currency: "INR", status: "captured" } } } };

    assert.equal((await webhook(event, { secret: "wrong-secret" })).status, 400);
    const [w1, v1, w2] = await Promise.all([
      webhook(event, { eventId: "evt_same" }),
      owner.post("/api/payments/verify").send({ orderId, paymentId: done.body.paymentId, signature: done.body.signature }),
      webhook(event, { eventId: "evt_same" }),
    ]);
    assert.ok([w1, v1, w2].every((r) => r.status === 200));
    assert.ok([w1.body.duplicate, w2.body.duplicate].includes(true), "same event id processed once");
    const counts = await ctx.pool.query(
      "SELECT (SELECT count(*)::int FROM connection_entitlements WHERE claim_id = $1) AS ents, (SELECT count(*)::int FROM connection_payments WHERE claim_id = $1 AND status = 'paid') AS paid",
      [claim.id]
    );
    assert.deepEqual(counts.rows[0], { ents: 1, paid: 1 });

    // Out-of-order failure after capture changes nothing.
    const late = { event: "payment.failed", payload: { payment: { entity: { id: "pay_testother", order_id: orderId, amount: 10000, currency: "INR", status: "failed" } } } };
    await webhook(late).expect(200);
    assert.equal((await ctx.pool.query("SELECT status FROM connection_payments WHERE claim_id = $1 AND status = 'paid'", [claim.id])).rowCount, 1);
    // Paying again is refused.
    assert.equal((await owner.post(`/api/claims/${claim.id}/checkout`).send({})).status, 409);
  });
});

describe("refunds and support", () => {
  test("approved refund revokes access; reward issues and refunds land in the support queue", async () => {
    const { owner, claim } = await acceptedFoundMatch("refund");
    await connect(owner, claim.id);
    assert.equal((await owner.post(`/api/claims/${claim.id}/refund-request`).send({ reason: "short" })).status, 400);
    await owner.post(`/api/claims/${claim.id}/refund-request`).send({ reason: "The finder never replied to my messages" }).expect(201);
    assert.equal((await owner.post(`/api/claims/${claim.id}/refund-request`).send({ reason: "The finder never replied to my messages" })).body.alreadyRequested, true);

    const mod = await ctx.agent({ email: "refund-mod@example.com", role: "moderator" });
    const queue = await mod.get("/api/moderation/support").expect(200);
    const request = queue.body.requests.find((r) => r.claimId === claim.id);
    assert.equal(request.kind, "refund");
    assert.equal(request.payment.status, "paid");
    const resolved = await mod.post(`/api/moderation/support/${request.id}/resolve`).send({ action: "approve_refund", note: "Finder unresponsive for 72h" }).expect(200);
    assert.equal(resolved.body.refund.status, "refunded");

    const state = await owner.get(`/api/claims/${claim.id}/payment`).expect(200);
    assert.equal(state.body.status, "refunded");
    const conv = await owner.get(`/api/conversations/${claim.conversationId}`).expect(200);
    assert.equal(conv.body.conversation.locked, true);
    assert.equal(conv.body.conversation.lockedReason, "refunded");
    assert.equal((await owner.post(`/api/conversations/${claim.conversationId}/messages`).send({ body: "hi" })).status, 402);
    // Owner may pay again to reconnect; the entitlement is reinstated once.
    await connect(owner, claim.id);
    assert.equal((await owner.get(`/api/conversations/${claim.conversationId}`)).body.conversation.locked, false);
  });
});

describe("terms renewal and legacy categories", () => {
  test("changing a found listing's category requires the owner to re-accept before the finder can accept", async () => {
    const finder = await ctx.agent({ email: "renew-finder@example.com" });
    const item = await createItem(finder, { type: "found", title: "Black thing", category: "wallet" });
    const owner = await ctx.agent({ email: "renew-owner@example.com" });
    const claim = await claimFound(owner, item);
    await finder.patch(`/api/items/${item.id}`).field("category", "electronics").expect(200);
    const res = await finder.post(`/api/claims/${claim.id}/accept`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "terms_renewal_required");
    assert.equal((await owner.post(`/api/claims/${claim.id}/terms`).send({ expectedRewardPaise: 30000 })).status, 409);
    const renewed = await owner.post(`/api/claims/${claim.id}/terms`).send({ expectedRewardPaise: 50000 }).expect(200);
    assert.equal(renewed.body.claim.agreement.rewardPaise, 50000);
    await finder.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
  });

  test("changing a lost listing's category requires a new acknowledgement and resets the reward", async () => {
    const owner = await ctx.agent({ email: "lost-cat@example.com" });
    const item = await createItem(owner, { type: "lost", title: "My thing", category: "bag" });
    assert.equal((await owner.patch(`/api/items/${item.id}`).field("category", "pet")).status, 400);
    const res = await owner.patch(`/api/items/${item.id}`).field("category", "pet").field("acceptRewardTerms", "true").field("expectedRewardPaise", "50000").expect(200);
    assert.equal(res.body.item.reward.amountPaise, 50000);
  });

  test("unconfirmed legacy categories block new matches until the poster confirms", async () => {
    const finder = await ctx.agent({ email: "legacy-finder@example.com" });
    const item = await createItem(finder, { type: "found", title: "Legacy item", category: "other" });
    await ctx.pool.query("UPDATE items SET category_confirmed = FALSE WHERE id = $1", [item.id]);
    const owner = await ctx.agent({ email: "legacy-owner@example.com" });
    const blocked = await owner.post(`/api/items/${item.id}/claims`).send({ answer: "Mine", acceptReward: true, expectedRewardPaise: 35000 });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "category_unconfirmed");
    assert.equal((await ctx.anonymous().get(`/api/items/${item.id}`)).body.item.categoryConfirmed, false);
    await finder.post(`/api/items/${item.id}/confirm-category`).send({ category: "keys" }).expect(200);
    await owner.post(`/api/items/${item.id}/claims`).send({ answer: "Mine", acceptReward: true, expectedRewardPaise: 30000 }).expect(201);
  });
});

describe("contact-detail safeguards", () => {
  test("listings with contact details are rejected, or held for review on request", async () => {
    const http = await ctx.agent({ email: "contact@example.com" });
    const base = (desc) => http.post("/api/items").field("type", "found").field("title", "Wallet").field("category", "wallet").field("location", "Pune").field("date", new Date().toISOString().slice(0, 10)).field("description", desc);
    const rejected = await base("Call me on 98765 43210");
    assert.equal(rejected.status, 422);
    assert.deepEqual(rejected.body.error.details.fields, { description: ["phone", "messaging"] });
    const held = await base("Model 9876543210 printed inside").field("reviewRequested", "true").expect(201);
    assert.equal((await ctx.anonymous().get(`/api/items/${held.body.item.id}`)).status, 404);
    const mod = await ctx.agent({ email: "contact-mod@example.com", role: "moderator" });
    assert.ok((await mod.get("/api/moderation/pending")).body.items.some((i) => i.id === held.body.item.id));
    await mod.post(`/api/moderation/items/${held.body.item.id}/restore`).send({ reason: "Serial number, not a phone" }).expect(200);
    assert.equal((await ctx.anonymous().get(`/api/items/${held.body.item.id}`)).status, 200);
  });

  test("claim answers with contact details are rejected so the claimant can edit", async () => {
    const finder = await ctx.agent({ email: "answer-finder@example.com" });
    const item = await createItem(finder, { type: "found", title: "Bag", category: "bag" });
    const owner = await ctx.agent({ email: "answer-owner@example.com" });
    const res = await owner.post(`/api/items/${item.id}/claims`).send({ answer: "email me at me@example.com", acceptReward: true, expectedRewardPaise: 30000 });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "contact_detected");
  });
});

describe("migration grandfathering", () => {
  test("conversations that existed before paid connections keep access; new ones start locked", async () => {
    const db = await createDatabase();
    const pool = new Pool({ connectionString: db.url });
    try {
      const dir = path.join(__dirname, "..", "migrations");
      await pool.query("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of ["000_base_schema", "001_update_items_user_fk", "002_add_item_type_check", "003_platform_core", "004_site_analytics"]) {
        await pool.query(fs.readFileSync(path.join(dir, `${file}.sql`), "utf8"));
        await pool.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, 'x')", [file]);
      }
      await pool.query(`
        INSERT INTO users (id, name, email) VALUES (1, 'A', 'a@x.com'), (2, 'B', 'b@x.com');
        INSERT INTO items (id, name, location, date, type, user_id, category) VALUES (1, 'Old wallet', 'Pune', '2026-01-01', 'found', 1, 'other'), (2, 'Old phone', 'Pune', '2026-01-01', 'lost', 1, 'phone');
        INSERT INTO conversations (item_id, reporter_id, participant_id) VALUES (1, 1, 2);
        INSERT INTO claims (item_id, claimant_id, answer, status) VALUES (1, 2, 'mine', 'accepted');`);
      const { loadConfig } = require("../src/config");
      const { createLogger } = require("../src/logger");
      const { runMigrations } = require("../src/migrate");
      const config = loadConfig(testEnv({ DATABASE_URL: db.url }));
      assert.deepEqual(await runMigrations(pool, createLogger(config)), ["005_rewards_and_paid_connections", "006_otp_challenges", "007_item_locations", "008_return_lifecycle"]);
      const conv = (await pool.query("SELECT unlocked_at, unlock_source FROM conversations")).rows[0];
      assert.ok(conv.unlocked_at);
      assert.equal(conv.unlock_source, "grandfathered");
      const claim = (await pool.query("SELECT owner_id, finder_id, owner_accepted_at, reward_status FROM claims")).rows[0];
      assert.deepEqual(claim, { owner_id: 2, finder_id: 1, owner_accepted_at: null, reward_status: "awaiting" }, "no retroactive acceptance");
      const items = (await pool.query("SELECT id, category_confirmed FROM items ORDER BY id")).rows;
      assert.deepEqual(items, [{ id: 1, category_confirmed: false }, { id: 2, category_confirmed: true }]);
      await pool.query("INSERT INTO conversations (item_id, reporter_id, participant_id) VALUES (2, 1, 2)");
      assert.equal((await pool.query("SELECT unlocked_at FROM conversations WHERE item_id = 2")).rows[0].unlocked_at, null);
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
