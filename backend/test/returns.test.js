"use strict";

// Item-return lifecycle: two-user journeys (owner A, finder B) through the
// API on real PostgreSQL, plus authorization, idempotency, races, payments,
// reminders, corrections, statistics and legacy data.
// Payments use the local test-mode provider (fixtures), not Razorpay.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { setup, createItem, createDatabase, claimFound, connect } = require("./helpers");
const { rewardFor } = require("../src/config/pricing");

let ctx;
let n = 0;
const uid = (label) => `${label}-${++n}@returns.test`;

before(async () => {
  ctx = await setup();
});
after(async () => ctx && ctx.teardown());

const stats = async () => (await ctx.anonymous().get("/api/stats").expect(200)).body;
const notes = async (user, type) =>
  (await ctx.pool.query("SELECT * FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY id", [user.user.id, type ?? null])).rows;
const itemRow = async (id) => (await ctx.pool.query("SELECT * FROM items WHERE id = $1", [id])).rows[0];
const claimRow = async (id) => (await ctx.pool.query("SELECT * FROM claims WHERE id = $1", [id])).rows[0];
const liveRecoveries = async (where = "TRUE", params = []) => (await ctx.pool.query(`SELECT * FROM recoveries WHERE corrected_at IS NULL AND ${where}`, params)).rows;
const searchTitles = async (q) => (await ctx.anonymous().get(`/api/items?q=${encodeURIComponent(q)}&pageSize=50`).expect(200)).body.items.map((i) => i.title);

// A lost listing (A) answered by finder B, accepted by A, connected (₹100 test payment).
async function lostMatch({ title = `Lost phone ${n}`, pay = true } = {}) {
  const A = await ctx.agent({ email: uid("owner") });
  const B = await ctx.agent({ email: uid("finder") });
  const item = await createItem(A, { type: "lost", title, category: "phone" });
  const claim = (await B.post(`/api/items/${item.id}/claims`).send({ answer: "Blue case, cracked corner" }).expect(201)).body.claim;
  await A.post(`/api/claims/${claim.id}/accept`).send({ acceptReward: true, expectedRewardPaise: rewardFor("phone") }).expect(200);
  if (pay) {
    const { verify } = await connect(A, claim.id);
    assert.equal(verify.body.status, "paid");
  }
  return { A, B, item, claim };
}

// A found listing (B) claimed by owner A, accepted by B, connected.
async function foundMatch({ title = `Found wallet ${n}` } = {}) {
  const A = await ctx.agent({ email: uid("owner") });
  const B = await ctx.agent({ email: uid("finder") });
  const item = await createItem(B, { type: "found", title, category: "wallet" });
  const claim = await claimFound(A, item, "Brown, has my library card");
  await B.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
  await connect(A, claim.id);
  return { A, B, item, claim };
}

// ---------------------------------------------------------------------------
describe("positive journeys", () => {
  test("A. lost listing, finder confirms handover first, owner confirms receipt", async () => {
    const before = await stats();
    const title = `ScenarioA phone ${Date.now().toString(36)}`;
    const { A, B, item, claim } = await lostMatch({ title });
    assert.equal((await itemRow(item.id)).status, "claimed");
    assert.ok((await searchTitles(title)).includes(title), "return being arranged: still listed");
    // New claims are paused while the match is active.
    const C = await ctx.agent({ email: uid("late") });
    assert.equal((await C.post(`/api/items/${item.id}/claims`).send({ answer: "mine" })).body.error.code, "not_open");

    const handover = await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    assert.equal(handover.body.claim.returnState, "awaiting_owner");
    const ownerNote = (await notes(A, "handover_reported"))[0];
    assert.equal(ownerNote.item_id, item.id);
    assert.equal(ownerNote.data.claimId, claim.id, "notification links the item and the claim");

    const done = await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal(done.body.claim.returnState, "returned");
    assert.equal(done.body.changed, true);
    assert.equal((await itemRow(item.id)).status, "returned");
    assert.equal((await itemRow(item.id)).closure_reason, "returned_matched");
    assert.ok(!(await searchTitles(title)).includes(title), "removed from active search");
    assert.equal((await notes(B, "return_confirmed")).length, 1);
    for (const user of [A, B]) {
      const history = (await user.get("/api/me/returns").expect(200)).body.returns;
      assert.equal(history[0].kind, "matched");
      assert.equal(history[0].lostItem.id, item.id);
      assert.ok(history[0].handoverAt && history[0].receiptConfirmedAt);
      assert.equal(history[0].payment.amountPaise, 10000);
    }
    assert.equal((await stats()).returned, before.returned + 1);
    // Old public link: closed state visible, privacy intact.
    const pub = await ctx.anonymous().get(`/api/items/${item.id}`).expect(200);
    assert.equal(pub.body.item.status, "returned");
    assert.equal(pub.body.item.closureReason, "returned_matched");
  });

  test("B. owner confirms receipt before the finder's handover; later handover keeps it returned", async () => {
    const { A, B, claim, item } = await lostMatch();
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal((await notes(B, "return_confirmed")).length, 1, "finder notified");
    const late = await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    assert.equal(late.body.changed, false);
    assert.equal(late.body.claim.returnState, "returned");
    assert.equal((await itemRow(item.id)).status, "returned");
    const events = (await ctx.pool.query("SELECT event, note FROM return_events WHERE claim_id = $1 ORDER BY id", [claim.id])).rows;
    assert.deepEqual(events.map((e) => e.event), ["receipt_confirmed", "return_completed"]);
    assert.equal(events[0].note, "before_handover");
  });

  test("C. found listing: owner claims with evidence, finder accepts, owner pays, handover and receipt", async () => {
    const { A, B, item, claim } = await foundMatch();
    await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    const r = await liveRecoveries("claim_id = $1", [claim.id]);
    assert.equal(r.length, 1);
    assert.equal(r[0].found_item_id, item.id);
    assert.equal(r[0].owner_id, A.user.id);
    assert.equal(r[0].finder_id, B.user.id);
  });

  test("D. linked lost + found listings complete together and count one recovery", async () => {
    const before = await stats();
    const A = await ctx.agent({ email: uid("owner") });
    const B = await ctx.agent({ email: uid("finder") });
    const C = await ctx.agent({ email: uid("other") });
    const tag = `Linked umbrella ${Date.now().toString(36)}`;
    const lost = await createItem(A, { type: "lost", title: `${tag} lost`, category: "other" });
    const found = await createItem(B, { type: "found", title: `${tag} found`, category: "other" });
    // A third person had a pending claim on A's lost listing.
    const cClaim = (await C.post(`/api/items/${lost.id}/claims`).send({ answer: "I saw one at the bus stop" }).expect(201)).body.claim;
    const claim = (await A.post(`/api/items/${found.id}/claims`).send({ answer: "Black with a wooden handle", acceptReward: true, expectedRewardPaise: rewardFor("other"), linkedItemId: lost.id }).expect(201)).body.claim;
    assert.equal(claim.linkedItemId, lost.id);
    await B.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
    assert.deepEqual([(await itemRow(lost.id)).status, (await itemRow(found.id)).status], ["claimed", "claimed"]);
    await connect(A, claim.id);
    await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);

    const [l, f] = [await itemRow(lost.id), await itemRow(found.id)];
    assert.deepEqual([l.status, f.status], ["returned", "returned"]);
    assert.equal(l.recovery_id, f.recovery_id, "one recovery record for both listings");
    const rec = await liveRecoveries("id = $1", [l.recovery_id]);
    assert.deepEqual([rec[0].lost_item_id, rec[0].found_item_id], [lost.id, found.id]);
    assert.deepEqual(await searchTitles(tag), [], "both gone from active results");
    assert.equal((await stats()).returned, before.returned + 1, "counted once");
    const superseded = await claimRow(cClaim.id);
    assert.deepEqual([superseded.status, superseded.close_reason], ["superseded", "item_returned"]);
    assert.equal((await notes(C, "claim_update")).at(-1).data.reason, "item_returned");
  });

  test("E. self-recovery closes the lost listing with its reason and a separate statistic", async () => {
    const before = await stats();
    const A = await ctx.agent({ email: uid("owner") });
    const C = await ctx.agent({ email: uid("claimant") });
    const title = `Self found keys ${Date.now().toString(36)}`;
    const item = await createItem(A, { type: "lost", title, category: "keys" });
    const pending = (await C.post(`/api/items/${item.id}/claims`).send({ answer: "Found near the gym" }).expect(201)).body.claim;
    assert.equal((await A.get(`/api/items/${item.id}/lifecycle`).expect(200)).body.pendingClaims, 1);
    assert.equal((await A.post(`/api/items/${item.id}/self-recovered`).send({})).status, 400, "explicit confirmation required");
    const res = await A.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true }).expect(200);
    assert.equal(res.body.item.status, "closed");
    assert.equal(res.body.item.closureReason, "self_recovered");
    assert.equal((await A.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true }).expect(200)).body.changed, false);
    assert.deepEqual(await searchTitles(title), []);
    assert.equal((await claimRow(pending.id)).close_reason, "item_self_recovered");
    const s = await stats();
    assert.equal(s.selfRecovered, before.selfRecovered + 1);
    assert.equal(s.returned, before.returned, "not an owner–finder return");
    assert.equal((await A.get("/api/me/returns").expect(200)).body.returns[0].kind, "self_recovered");
    // Can't simply reopen a recovery closure.
    assert.equal((await A.post(`/api/items/${item.id}/status`).send({ status: "open" })).body.error.code, "correction_required");
  });

  test("E2. self-recovery with an active paid match: match cancelled, finder told, payment kept, refund path open", async () => {
    const { A, B, item, claim } = await lostMatch();
    const preview = (await A.get(`/api/items/${item.id}/lifecycle`).expect(200)).body;
    assert.deepEqual(preview.activeMatch, { claimId: claim.id, unlocked: true, paid: true, viewerIsOwner: true });
    const res = await A.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true }).expect(200);
    assert.deepEqual(res.body.paidConnections, [{ claimId: claim.id, paymentStatus: "paid", refundRequestable: true }]);
    assert.equal((await claimRow(claim.id)).status, "revoked");
    assert.equal((await notes(B, "item_status")).at(-1).data.closureReason, "self_recovered");
    const pay = (await ctx.pool.query("SELECT status FROM connection_payments WHERE claim_id = $1", [claim.id])).rows;
    assert.deepEqual(pay.map((p) => p.status), ["paid"], "financial record untouched");
    await A.post(`/api/claims/${claim.id}/refund-request`).send({ reason: "Found it myself before we met" }).expect(201);
  });

  test("F. external return archives a found listing with a distinct status", async () => {
    const before = await stats();
    const B = await ctx.agent({ email: uid("finder") });
    const A = await ctx.agent({ email: uid("owner") });
    const title = `External bag ${Date.now().toString(36)}`;
    const item = await createItem(B, { type: "found", title, category: "bag" });
    await claimFound(A, item);
    assert.equal((await A.post(`/api/items/${item.id}/returned-externally`).send({ confirm: true })).status, 403, "only the reporter");
    const res = await B.post(`/api/items/${item.id}/returned-externally`).send({ confirm: true, note: "Gave it to the station master" }).expect(200);
    assert.deepEqual([res.body.item.status, res.body.item.closureReason], ["closed", "returned_external"]);
    assert.deepEqual(await searchTitles(title), []);
    const s = await stats();
    assert.equal(s.externalReturns, before.externalReturns + 1);
    assert.equal(s.returned, before.returned);
    assert.equal((await B.get("/api/me/returns").expect(200)).body.returns[0].kind, "external");
    assert.equal((await B.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true })).body.error.code, "wrong_listing_type");
  });

  test("G. reward receipt is tracked separately from the return", async () => {
    const { A, B, claim, item } = await lostMatch();
    assert.equal((await B.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" })).body.error.code, "return_not_completed");
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal((await A.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" })).status, 403, "owner can't confirm for the finder");
    const ok = await B.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" }).expect(200);
    assert.equal(ok.body.claim.reward.status, "confirmed");
    const row = await claimRow(claim.id);
    assert.equal(row.reward_status_by, B.user.id);
    assert.ok(row.reward_status_at);
    assert.equal((await itemRow(item.id)).status, "returned");

    const second = await lostMatch();
    await second.A.post(`/api/claims/${second.claim.id}/return`).send({}).expect(200);
    await second.B.post(`/api/claims/${second.claim.id}/reward`).send({ status: "issue", note: "Owner promised UPI later, nothing yet" }).expect(200);
    assert.equal((await claimRow(second.claim.id)).reward_status, "issue");
    assert.equal((await itemRow(second.item.id)).status, "returned", "reward issue never reopens the listing");
    assert.ok((await claimRow(second.claim.id)).return_confirmed_at, "return record unchanged");
    const support = (await ctx.pool.query("SELECT kind, item_id FROM support_requests WHERE claim_id = $1", [second.claim.id])).rows;
    assert.deepEqual(support, [{ kind: "reward_issue", item_id: second.item.id }]);
  });

  test("H. correction of an accidental completion through the support queue", async () => {
    const { A, B, claim, item } = await lostMatch();
    const C = await ctx.agent({ email: uid("pending") });
    // C's claim can't be made while claimed; seed one directly as an earlier pending claim.
    const cClaim = (await ctx.pool.query("INSERT INTO claims (item_id, claimant_id, answer, owner_id, finder_id) VALUES ($1, $2, 'mine', $3, $2) RETURNING id", [item.id, C.user.id, A.user.id])).rows[0].id;
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    const s1 = await stats();
    const outsider = await ctx.agent({ email: uid("outsider") });
    assert.equal((await outsider.post(`/api/items/${item.id}/correction-request`).send({ reason: "This is not right at all" })).status, 404);
    await A.post(`/api/items/${item.id}/correction-request`).send({ reason: "I tapped received by mistake; we haven't met yet" }).expect(201);
    assert.equal((await B.post(`/api/items/${item.id}/correction-request`).send({ reason: "Same request from the finder side" }).expect(200)).body.alreadyRequested, true);
    const support = (await ctx.pool.query("SELECT id FROM support_requests WHERE kind = 'return_correction' AND item_id = $1", [item.id])).rows[0];
    const mod = await ctx.agent({ email: uid("mod"), role: "moderator" });
    assert.equal((await A.post(`/api/moderation/support/${support.id}/resolve`).send({ action: "reopen", note: "nope" })).status, 403, "participants can't resolve");
    await mod.post(`/api/moderation/support/${support.id}/resolve`).send({ action: "reopen", note: "Owner confirmed by mistake" }).expect(200);

    const it = await itemRow(item.id);
    assert.deepEqual([it.status, it.closure_reason, it.recovery_id], ["claimed", null, null]);
    const c = await claimRow(claim.id);
    assert.deepEqual([c.status, c.return_confirmed_at, c.handover_at], ["accepted", null, null]);
    assert.equal((await claimRow(cClaim)).status, "superseded", "claims closed by the completion stay closed");
    assert.equal((await stats()).returned, s1.returned - 1, "corrected recovery no longer counted");
    const rec = (await ctx.pool.query("SELECT corrected_by, correction_reason FROM recoveries WHERE claim_id = $1", [claim.id])).rows[0];
    assert.equal(rec.corrected_by, mod.user.id);
    assert.equal(rec.correction_reason, "Owner confirmed by mistake");
    assert.equal((await notes(B, "return_corrected")).length, 1);
    // The real return later: a new recovery, counted once again.
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal((await stats()).returned, s1.returned);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM recoveries WHERE claim_id = $1", [claim.id])).rows[0].n, 2);
    const events = (await ctx.pool.query("SELECT event FROM return_events WHERE claim_id = $1 ORDER BY id", [claim.id])).rows.map((r) => r.event);
    assert.deepEqual(events, ["receipt_confirmed", "return_completed", "correction_requested", "correction_applied", "receipt_confirmed", "return_completed"]);
  });
});

// ---------------------------------------------------------------------------
describe("authorization and invalid transitions", () => {
  test("only the right participant can act; others are rejected", async () => {
    const { A, B, claim, item } = await lostMatch();
    const outsider = await ctx.agent({ email: uid("outsider") });
    for (const p of ["return", "handover", "return-issue"]) {
      assert.equal((await ctx.anonymous().post(`/api/claims/${claim.id}/${p}`).send({})).status, 403, `anon ${p} (CSRF)`);
    }
    const anon = ctx.anonymous();
    const me = await anon.get("/api/auth/me");
    const csrf = me.body.csrfToken;
    const cookie = me.headers["set-cookie"];
    assert.equal((await anon.post(`/api/claims/${claim.id}/return`).set("Cookie", cookie || []).set("X-CSRF-Token", csrf).send({})).status, 401);
    assert.equal((await B.post(`/api/claims/${claim.id}/return`).send({})).body.error.code, "not_owner");
    assert.equal((await A.post(`/api/claims/${claim.id}/handover`).send({})).body.error.code, "not_finder");
    assert.equal((await outsider.post(`/api/claims/${claim.id}/return`).send({})).status, 404);
    assert.equal((await outsider.post(`/api/claims/${claim.id}/handover`).send({})).status, 404);
    assert.equal((await outsider.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true })).status, 403);
    assert.equal((await B.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true })).status, 403);
    assert.equal((await A.post("/api/claims/abc/return").send({})).status, 400);
    assert.equal((await A.post("/api/claims/99999999/return").send({})).status, 404);
    assert.equal((await A.post(`/api/items/${item.id}/status`).send({ status: "returned" })).body.error.code, "invalid_transition");
    assert.equal((await itemRow(item.id)).status, "claimed", "nothing changed");
  });

  test("pending and declined claimants can't complete; actions need a connected match", async () => {
    const A = await ctx.agent({ email: uid("owner") });
    const B = await ctx.agent({ email: uid("finder") });
    const C = await ctx.agent({ email: uid("rejected") });
    const item = await createItem(A, { type: "lost", title: "Neg wallet", category: "wallet" });
    const bClaim = (await B.post(`/api/items/${item.id}/claims`).send({ answer: "brown" }).expect(201)).body.claim;
    const cClaim = (await C.post(`/api/items/${item.id}/claims`).send({ answer: "black" }).expect(201)).body.claim;
    assert.equal((await B.post(`/api/claims/${bClaim.id}/handover`).send({})).body.error.code, "match_not_accepted");
    await A.post(`/api/claims/${cClaim.id}/decline`).send({}).expect(200);
    assert.equal((await C.post(`/api/claims/${cClaim.id}/handover`).send({})).body.error.code, "match_not_accepted");
    assert.equal((await C.post(`/api/claims/${bClaim.id}/handover`).send({})).status, 404, "not their match");
    await A.post(`/api/claims/${bClaim.id}/accept`).send({ acceptReward: true, expectedRewardPaise: rewardFor("wallet") }).expect(200);
    assert.equal((await B.post(`/api/claims/${bClaim.id}/handover`).send({})).status, 402, "connect first");
    assert.equal((await A.post(`/api/claims/${bClaim.id}/return`).send({})).status, 402);
  });

  test("returned items take no new claims or paid connections", async () => {
    const { A, claim, item } = await lostMatch();
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    const D = await ctx.agent({ email: uid("late") });
    assert.equal((await D.post(`/api/items/${item.id}/claims`).send({ answer: "mine" })).body.error.code, "not_open");
    assert.equal((await A.post(`/api/claims/${claim.id}/checkout`).send({})).status, 409);
  });
});

// ---------------------------------------------------------------------------
describe("idempotency and races", () => {
  test("duplicate receipt confirmations: one completion, one notification, one recovery", async () => {
    const { A, B, claim } = await lostMatch();
    const results = await Promise.all(Array.from({ length: 6 }, () => A.post(`/api/claims/${claim.id}/return`).send({})));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results.filter((r) => r.body.changed).length, 1);
    assert.equal((await notes(B, "return_confirmed")).length, 1);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM recoveries WHERE claim_id = $1", [claim.id])).rows[0].n, 1);
    // Network failure after success: the retry sees the same final state.
    const retry = await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.deepEqual([retry.body.changed, retry.body.claim.returnState], [false, "returned"]);
  });

  test("concurrent handover and receipt converge on one returned state", async () => {
    for (let i = 0; i < 3; i++) {
      const { A, B, claim, item } = await lostMatch();
      const [h, r] = await Promise.all([B.post(`/api/claims/${claim.id}/handover`).send({}), A.post(`/api/claims/${claim.id}/return`).send({})]);
      assert.deepEqual([h.status, r.status], [200, 200]);
      assert.equal((await itemRow(item.id)).status, "returned");
      assert.equal((await liveRecoveries("claim_id = $1", [claim.id])).length, 1);
    }
  });

  test("receipt racing with the poster cancelling the match resolves to one outcome", async () => {
    for (let i = 0; i < 3; i++) {
      const { A, B, claim, item } = await foundMatch();
      const [ret, cancel] = await Promise.all([A.post(`/api/claims/${claim.id}/return`).send({}), B.post(`/api/items/${item.id}/status`).send({ status: "open" })]);
      const it = await itemRow(item.id);
      const c = await claimRow(claim.id);
      const recs = await liveRecoveries("claim_id = $1", [claim.id]);
      if (it.status === "returned") {
        assert.deepEqual([ret.status, cancel.status, c.status, recs.length], [200, 409, "accepted", 1]);
      } else {
        assert.deepEqual([ret.status, cancel.status, it.status, c.status, recs.length], [409, 200, "open", "revoked", 0]);
      }
    }
  });

  test("a new claim can't slip in while a listing closes", async () => {
    for (let i = 0; i < 3; i++) {
      const A = await ctx.agent({ email: uid("owner") });
      const D = await ctx.agent({ email: uid("racer") });
      const item = await createItem(A, { type: "lost", title: `Race keys ${i}`, category: "keys" });
      await Promise.all([A.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true }), D.post(`/api/items/${item.id}/claims`).send({ answer: "found it" })]);
      const pending = (await ctx.pool.query("SELECT count(*)::int AS n FROM claims WHERE item_id = $1 AND status = 'pending'", [item.id])).rows[0].n;
      assert.equal(pending, 0);
      assert.equal((await itemRow(item.id)).status, "closed");
    }
  });

  test("closing the listing while the connection payment is in flight: no unlock, refund request opened", async () => {
    const { A, claim, item } = await lostMatch({ pay: false });
    const checkout = (await A.post(`/api/claims/${claim.id}/checkout`).send({}).expect(200)).body.checkout;
    await A.post(`/api/items/${item.id}/self-recovered`).send({ confirm: true }).expect(200);
    const done = (await A.post("/api/payments/test/complete").send({ orderId: checkout.orderId, outcome: "success" })).body;
    const verify = await A.post("/api/payments/verify").send({ orderId: checkout.orderId, paymentId: done.paymentId, signature: done.signature });
    assert.equal(verify.body.status, "paid", "the payment itself is recorded");
    const conv = (await ctx.pool.query("SELECT unlocked_at FROM conversations WHERE item_id = $1", [item.id])).rows[0];
    assert.equal(conv.unlocked_at, null, "no connection unlocked for a closed match");
    const refund = (await ctx.pool.query("SELECT kind, status FROM support_requests WHERE claim_id = $1", [claim.id])).rows;
    assert.deepEqual(refund, [{ kind: "refund", status: "open" }]);
    assert.equal((await A.post(`/api/claims/${claim.id}/checkout`).send({})).status, 409, "no new checkout");
  });
});

// ---------------------------------------------------------------------------
describe("problems, reminders and visibility", () => {
  test("owner reports a problem: recorded, return stays unresolved; no reports after completion", async () => {
    const { A, B, claim, item } = await lostMatch();
    await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    const res = await A.post(`/api/claims/${claim.id}/return-issue`).send({ note: "The phone handed over is not mine" }).expect(201);
    assert.deepEqual([res.body.claim.returnState, res.body.claim.returnIssueOpen], ["awaiting_owner", true]);
    assert.equal((await A.post(`/api/claims/${claim.id}/return-issue`).send({ note: "Still not mine, please help" }).expect(200)).body.changed, false);
    assert.equal((await itemRow(item.id)).status, "claimed");
    const support = (await ctx.pool.query("SELECT kind, status FROM support_requests WHERE claim_id = $1", [claim.id])).rows;
    assert.deepEqual(support, [{ kind: "return_issue", status: "open" }]);
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal((await A.post(`/api/claims/${claim.id}/return-issue`).send({ note: "late problem here" })).body.error.code, "return_completed");
  });

  test("missing owner response: reminders only, never an automatic confirmation", async () => {
    const { A, B, claim, item } = await lostMatch();
    await B.post(`/api/claims/${claim.id}/handover`).send({}).expect(200);
    const returns = ctx.app.locals.returns;
    assert.equal(await returns.sendReturnReminders(), 0, "too early");
    await ctx.pool.query("UPDATE claims SET handover_at = now() - interval '49 hours' WHERE id = $1", [claim.id]);
    await returns.sendReturnReminders();
    await returns.sendReturnReminders();
    assert.equal((await notes(A, "return_reminder")).length, 1, "one reminder per step");
    await ctx.pool.query("UPDATE claims SET handover_at = now() - interval '8 days' WHERE id = $1", [claim.id]);
    await returns.sendReturnReminders();
    assert.deepEqual((await notes(A, "return_reminder")).map((r) => r.data.reminder), [1, 2]);
    assert.equal((await claimRow(claim.id)).return_confirmed_at, null);
    assert.equal((await itemRow(item.id)).status, "claimed");
  });

  test("result counts and pagination update when listings complete", async () => {
    const A = await ctx.agent({ email: uid("pager") });
    const tag = `PageCount${Date.now().toString(36)}`;
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await createItem(A, { type: "lost", title: `${tag} ${i}`, category: "keys" })).id);
    const q = `/api/items?q=${tag}&pageSize=2`;
    assert.deepEqual([(await ctx.anonymous().get(q)).body.total, (await ctx.anonymous().get(q)).body.totalPages], [5, 3]);
    for (const id of ids.slice(0, 3)) await A.post(`/api/items/${id}/self-recovered`).send({ confirm: true }).expect(200);
    const after3 = (await ctx.anonymous().get(q)).body;
    assert.deepEqual([after3.total, after3.totalPages], [2, 1]);
    assert.equal((await ctx.anonymous().get(`${q}&page=2`)).body.items.length, 0);
    for (const id of ids.slice(3)) await A.post(`/api/items/${id}/self-recovered`).send({ confirm: true }).expect(200);
    assert.equal((await ctx.anonymous().get(q)).body.total, 0);
    // Still in the owner's own listings.
    const mine = (await A.get("/api/me/items")).body.items.filter((i) => i.title.startsWith(tag));
    assert.equal(mine.length, 5);
    assert.ok(mine.every((i) => i.status === "closed" && i.closureReason === "self_recovered"));
  });

  test("completed listings stop receiving match suggestions", async () => {
    const { A, claim, item } = await lostMatch({ title: "Suggest black phone samsung" });
    const B2 = await ctx.agent({ email: uid("finder2") });
    const found = await createItem(B2, { type: "found", title: "Suggest black phone samsung", category: "phone" });
    await A.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    const matches = (await B2.get(`/api/items/${found.id}/matches`).expect(200)).body.matches;
    assert.ok(!matches.some((m) => m.item.id === item.id));
  });
});

// ---------------------------------------------------------------------------
describe("migration 008 legacy handling", () => {
  test("existing returned/closed listings are classified without double counting", async () => {
    const db = await createDatabase();
    const pool = new Pool({ connectionString: db.url });
    try {
      const dir = path.join(__dirname, "..", "migrations");
      for (const f of fs.readdirSync(dir).filter((f) => f < "008").sort()) await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await pool.query(`
        INSERT INTO users (id, name, email) VALUES (1, 'Owner', 'o@x.com'), (2, 'Finder', 'f@x.com');
        INSERT INTO items (id, name, location, date, type, user_id, category, status) VALUES
          (1, 'Confirmed return', 'Pune', '2026-01-01', 'found', 2, 'wallet', 'returned'),
          (2, 'Poster-marked return', 'Pune', '2026-01-01', 'found', 2, 'bag', 'returned'),
          (3, 'Closed listing', 'Pune', '2026-01-01', 'lost', 1, 'keys', 'closed'),
          (4, 'Open listing', 'Pune', '2026-01-01', 'lost', 1, 'keys', 'open');
        INSERT INTO claims (item_id, claimant_id, answer, status, owner_id, finder_id, return_confirmed_at, return_confirmed_by)
          VALUES (1, 1, 'mine', 'accepted', 1, 2, now(), 1), (2, 1, 'mine', 'accepted', 1, 2, NULL, NULL);`);
      const sql = fs.readFileSync(path.join(dir, "008_return_lifecycle.sql"), "utf8");
      await pool.query(sql);
      await pool.query(sql); // re-runnable
      const items = (await pool.query("SELECT id, status, closure_reason, recovery_id IS NOT NULL AS has_recovery FROM items ORDER BY id")).rows;
      assert.deepEqual(items, [
        { id: 1, status: "returned", closure_reason: "returned_matched", has_recovery: true },
        { id: 2, status: "returned", closure_reason: "legacy_returned", has_recovery: true },
        { id: 3, status: "closed", closure_reason: "closed_by_reporter", has_recovery: false },
        { id: 4, status: "open", closure_reason: null, has_recovery: false },
      ]);
      const kinds = (await pool.query("SELECT kind, count(*)::int AS n FROM recoveries GROUP BY kind ORDER BY kind")).rows;
      assert.deepEqual(kinds, [
        { kind: "legacy", n: 1 },
        { kind: "matched", n: 1 },
      ]);
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
