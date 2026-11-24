"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { setup, pngImage, createItem, daysAgo, claimFound, connect } = require("./helpers");

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.teardown());

describe("browse and search", () => {
  let bulk;
  before(async () => {
    bulk = await ctx.agent({ email: "bulk@example.com", name: "Bulk Poster" });
    // 25 listings; the distinctive one is the OLDEST so it sits beyond page 1.
    await createItem(bulk, { title: "Vintage brass compass", category: "other", location: "Shaniwar Wada", date: daysAgo(20) });
    for (let i = 0; i < 24; i++) {
      await createItem(bulk, { title: `Blue umbrella ${i}`, category: i % 2 ? "bag" : "other", location: i % 3 ? "Koregaon Park" : "Hinjewadi", date: daysAgo(i % 10) });
    }
  });

  test("paginates with stable totals and finds listings beyond the first page", async () => {
    const anon = ctx.anonymous();
    const page1 = await anon.get("/api/items?type=lost&pageSize=10").expect(200);
    assert.equal(page1.body.total, 25);
    assert.equal(page1.body.totalPages, 3);
    assert.ok(!page1.body.items.some((i) => i.title.includes("compass")));
    const page3 = await anon.get("/api/items?type=lost&pageSize=10&page=3").expect(200);
    assert.equal(page3.body.items.length, 5);
    assert.ok(page3.body.items.some((i) => i.title.includes("compass")));

    const ids = new Set();
    for (const page of [1, 2, 3]) {
      for (const item of (await anon.get(`/api/items?type=lost&pageSize=10&page=${page}`)).body.items) ids.add(item.id);
    }
    assert.equal(ids.size, 25, "pages must not overlap or skip");

    const search = await anon.get("/api/items?q=compass").expect(200);
    assert.equal(search.body.total, 1);
  });

  test("filters by category, location and date range", async () => {
    const anon = ctx.anonymous();
    const bags = await anon.get("/api/items?category=bag").expect(200);
    assert.ok(bags.body.items.every((i) => i.category === "bag"));
    const hinjewadi = await anon.get("/api/items?location=hinjewadi").expect(200);
    assert.ok(hinjewadi.body.total > 0 && hinjewadi.body.items.every((i) => /hinjewadi/i.test(i.location)));
    const range = await anon.get(`/api/items?from=${daysAgo(2)}&to=${daysAgo(0)}&pageSize=50`).expect(200);
    assert.ok(range.body.items.every((i) => i.date >= daysAgo(2)));
  });

  test("distance search uses coordinates without exposing them", async () => {
    const poster = await ctx.agent({ email: "geo@example.com" });
    await createItem(poster, { title: "Red scarf near station", category: "clothing", latitude: "18.5289", longitude: "73.8744" });
    await createItem(poster, { title: "Red scarf in Mumbai", category: "clothing", latitude: "19.0760", longitude: "72.8777" });
    const near = await ctx.anonymous().get("/api/items?q=scarf&lat=18.53&lng=73.87&radiusKm=10&sort=distance").expect(200);
    assert.equal(near.body.total, 1);
    assert.equal(near.body.items[0].title, "Red scarf near station");
    assert.ok(near.body.items[0].distanceKm < 2);
  });

  test("invalid query parameters are rejected", async () => {
    const anon = ctx.anonymous();
    for (const qs of ["type=stolen", "page=0", "pageSize=500", "from=2026-02-30", "sort=distance", "lat=10", "category=cars", "unknown=1"]) {
      const res = await anon.get(`/api/items?${qs}`);
      assert.equal(res.status, 400, `expected 400 for ${qs}`);
      assert.equal(res.body.error.code, "validation_failed");
    }
    assert.equal((await anon.get("/api/items/abc")).status, 400);
    assert.equal((await anon.get("/api/items/999999")).status, 404);
  });
});

describe("listing management", () => {
  test("owner creates, edits (images too) and deletes; changes persist", async () => {
    const owner = await ctx.agent({ email: "editor@example.com", name: "Edit Or" });
    const item = await createItem(owner, { title: "Grey backpack", category: "bag" }, [await pngImage(), await pngImage(300, 200)]);
    const res = await owner
      .patch(`/api/items/${item.id}`)
      .field("title", "Grey Wildcraft backpack")
      .field("removeImageIds", String(item.images[0].id))
      .attach("images", await pngImage(400, 300), "new.png")
      .expect(200);
    assert.equal(res.body.item.title, "Grey Wildcraft backpack");
    assert.equal(res.body.item.images.length, 2);
    assert.equal((await ctx.anonymous().get(item.images[0].url)).status, 404, "removed image is gone");

    const fresh = await ctx.anonymous().get(`/api/items/${item.id}`).expect(200);
    assert.equal(fresh.body.item.title, "Grey Wildcraft backpack");

    await owner.delete(`/api/items/${item.id}`).expect(204);
    assert.equal((await ctx.anonymous().get(`/api/items/${item.id}`)).status, 404);
    assert.equal((await ctx.anonymous().get(fresh.body.item.images[0].url)).status, 404);
  });

  test("rejects future dates and bad fields", async () => {
    const owner = await ctx.agent({ email: "badfields@example.com" });
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const res = await owner
      .post("/api/items")
      .field("type", "lost")
      .field("title", "X")
      .field("category", "cars")
      .field("location", "Pune")
      .field("date", tomorrow);
    assert.equal(res.status, 400);
    const paths = res.body.error.fields.map((f) => f.path).sort();
    assert.deepEqual(paths, ["category", "date", "title"]);
  });

  test("status transitions are enforced", async () => {
    const owner = await ctx.agent({ email: "transitions@example.com" });
    const item = await createItem(owner);
    const bad = await owner.post(`/api/items/${item.id}/status`).send({ status: "returned" });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, "invalid_transition");
    await owner.post(`/api/items/${item.id}/status`).send({ status: "closed" }).expect(200);
    await owner.post(`/api/items/${item.id}/status`).send({ status: "open" }).expect(200);
  });
});

describe("contact, claim and return journey", () => {
  test("Path B: owner claims a found item, finder accepts, owner pays ₹100, chat unlocks, return confirmed", async () => {
    const reporter = await ctx.agent({ email: "finder@example.com", name: "Finder Person" });
    await reporter.patch("/api/account/profile").send({ phone: "+44 7911 123456" }).expect(200);
    const item = await createItem(reporter, {
      type: "found",
      title: "Brown leather wallet",
      category: "wallet",
      ownershipQuestion: "What card is in the front slot?",
    });
    const owner = await ctx.agent({ email: "realowner@example.com", name: "Real Owner" });

    // Free text before payment is not allowed; the claim is the structured channel.
    assert.equal((await owner.post(`/api/items/${item.id}/conversations`).send({ body: "Hi, I think this is mine" })).status, 402);
    const claim = await claimFound(owner, item, "Library card");
    assert.equal(claim.status, "pending");
    assert.equal(claim.agreement.rewardPaise, 30000);
    assert.equal(claim.agreement.feePaise, 10000);
    const convId = claim.conversationId;

    const notes = await reporter.get("/api/notifications").expect(200);
    assert.ok(notes.body.notifications.some((n) => n.type === "claim_received"));

    const view = await reporter.get(`/api/conversations/${convId}`).expect(200);
    assert.equal(view.body.conversation.locked, true);
    assert.equal(view.body.conversation.claims[0].answer, "Library card");
    assert.deepEqual(view.body.conversation.messages, []);
    assert.equal((await reporter.post(`/api/conversations/${convId}/messages`).send({ body: "hello" })).status, 402);
    assert.equal((await reporter.post(`/api/conversations/${convId}/phone-sharing`).send({ share: true })).status, 402);

    await reporter.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
    assert.equal((await ctx.anonymous().get(`/api/items/${item.id}`)).body.item.status, "claimed");
    assert.ok((await owner.get("/api/notifications")).body.notifications.some((n) => n.type === "payment_due"));
    // The finder can't pay; only the owner.
    assert.equal((await reporter.post(`/api/claims/${claim.id}/checkout`).send({})).status, 403);

    const paid = await connect(owner, claim.id);
    assert.equal(paid.checkout.amountPaise, 10000);
    assert.equal(paid.checkout.currency, "INR");
    assert.equal(paid.checkout.rewardPaise, 30000);
    assert.equal(paid.verify.status, 200);
    assert.equal(paid.verify.body.status, "paid");

    const unlocked = await owner.get(`/api/conversations/${convId}`).expect(200);
    assert.equal(unlocked.body.conversation.locked, false);
    await owner.post(`/api/conversations/${convId}/messages`).send({ body: "Thanks! When can we meet?" }).expect(201);
    assert.equal(unlocked.body.conversation.counterpart.phone, null, "paying never exposes a phone number");

    // Deliberate, reversible phone sharing by the finder.
    await reporter.post(`/api/conversations/${convId}/phone-sharing`).send({ share: true }).expect(200);
    assert.equal((await owner.get(`/api/conversations/${convId}`)).body.conversation.counterpart.phone, "+447911123456");
    await reporter.post(`/api/conversations/${convId}/phone-sharing`).send({ share: false }).expect(200);
    assert.equal((await owner.get(`/api/conversations/${convId}`)).body.conversation.counterpart.phone, null);

    // Return and reward receipt are separate facts, each by the right party.
    assert.equal((await reporter.post(`/api/claims/${claim.id}/return`).send({})).status, 403);
    const returned = await owner.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.ok(returned.body.claim.returnConfirmedAt);
    assert.equal(returned.body.claim.reward.status, "awaiting");
    assert.equal((await ctx.anonymous().get(`/api/items/${item.id}`)).body.item.status, "returned");
    assert.equal((await owner.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" })).status, 403);
    const rewarded = await reporter.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" }).expect(200);
    assert.equal(rewarded.body.claim.reward.status, "confirmed");
    const again = await reporter.post(`/api/claims/${claim.id}/reward`).send({ status: "confirmed" }).expect(200);
    assert.equal(again.body.changed, false);
    assert.equal((await ctx.anonymous().get("/api/items?q=Brown leather wallet")).body.total, 0, "returned items leave the active list");
  });

  test("Path A: finder responds to a lost item, owner accepts with reward, pays, reward issue recorded with return", async () => {
    const owner = await ctx.agent({ email: "lost-owner@example.com", name: "Lost Owner" });
    const item = await createItem(owner, { type: "lost", title: "Grey Samsung phone", category: "phone", ownershipQuestion: "What colour is the case?" });
    assert.equal(item.reward.kind, "finder_reward");
    assert.equal(item.reward.amountPaise, 50000);
    const finder = await ctx.agent({ email: "lost-finder@example.com", name: "Kind Finder" });
    const res = await finder.post(`/api/items/${item.id}/claims`).send({ answer: "Blue case with a sticker" }).expect(201);
    const claim = res.body.claim;
    assert.equal(claim.claimantRole, "finder");
    assert.equal(claim.agreement, null, "finders never accept reward terms");

    // Owner must accept the reward explicitly; a tampered amount is rejected.
    assert.equal((await owner.post(`/api/claims/${claim.id}/accept`).send({})).status, 400);
    const tampered = await owner.post(`/api/claims/${claim.id}/accept`).send({ acceptReward: true, expectedRewardPaise: 100 });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.error.code, "pricing_changed");
    const accepted = await owner.post(`/api/claims/${claim.id}/accept`).send({ acceptReward: true, expectedRewardPaise: 50000 }).expect(200);
    assert.equal(accepted.body.claim.agreement.rewardPaise, 50000);

    await connect(owner, claim.id);
    await owner.post(`/api/claims/${claim.id}/return`).send({}).expect(200);
    assert.equal((await finder.post(`/api/claims/${claim.id}/reward`).send({ status: "issue" })).status, 400, "issue needs a note");
    const issue = await finder.post(`/api/claims/${claim.id}/reward`).send({ status: "issue", note: "Owner left without paying" }).expect(200);
    assert.equal(issue.body.claim.reward.status, "issue");
    assert.ok(issue.body.claim.returnConfirmedAt, "return stays recorded despite the dispute");
    const { rows } = await ctx.pool.query("SELECT kind, status FROM support_requests WHERE claim_id = $1", [claim.id]);
    assert.deepEqual(rows, [{ kind: "reward_issue", status: "open" }]);
    // Snapshot is immutable once accepted.
    await assert.rejects(ctx.pool.query("UPDATE claims SET reward_paise = 1 WHERE id = $1", [claim.id]), /immutable/);
  });

  test("a third user cannot read conversations, see claims, pay, edit, or moderate", async () => {
    const reporter = await ctx.agent({ email: "r3@example.com" });
    const item = await createItem(reporter, { type: "found", title: "Keys with red tag", category: "keys", ownershipQuestion: "Keychain?" });
    const claimant = await ctx.agent({ email: "c3@example.com" });
    const claim = await claimFound(claimant, item, "Red tag says HOME");
    await reporter.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
    await connect(claimant, claim.id);

    const intruder = await ctx.agent({ email: "intruder@example.com" });
    assert.equal((await intruder.get(`/api/conversations/${claim.conversationId}`)).status, 404);
    assert.equal((await intruder.post(`/api/conversations/${claim.conversationId}/messages`).send({ body: "hi" })).status, 404);
    assert.equal((await intruder.get(`/api/items/${item.id}/claims`).expect(200)).body.claims.length, 0);
    assert.equal((await intruder.post(`/api/claims/${claim.id}/accept`).send({})).status, 404);
    assert.equal((await intruder.post(`/api/claims/${claim.id}/checkout`).send({})).status, 404);
    assert.equal((await intruder.get(`/api/claims/${claim.id}/payment`)).status, 404);
    assert.equal((await intruder.post(`/api/claims/${claim.id}/return`).send({})).status, 404);
    assert.equal((await intruder.patch(`/api/items/${item.id}`).field("title", "Hacked")).status, 403);
    assert.equal((await intruder.delete(`/api/items/${item.id}`)).status, 403);
    assert.equal((await intruder.get("/api/moderation/queue")).status, 403);
    assert.equal((await intruder.get("/api/moderation/support")).status, 403);
    assert.equal((await intruder.get(`/api/items/${item.id}/matches`)).status, 403);
    assert.equal((await claimant.post(`/api/claims/${claim.id}/accept`).send({})).status, 403);
    const anon = ctx.anonymous();
    assert.equal((await anon.get("/api/conversations")).status, 401);
    assert.equal((await anon.post(`/api/claims/${claim.id}/checkout`).send({})).status, 403, "CSRF/auth blocks anonymous checkout");
  });

  test("a paid match unlocks only its own conversation", async () => {
    const finder = await ctx.agent({ email: "two-matches-finder@example.com" });
    const first = await createItem(finder, { type: "found", title: "Red bag one", category: "bag" });
    const second = await createItem(finder, { type: "found", title: "Red bag two", category: "bag" });
    const owner = await ctx.agent({ email: "two-matches-owner@example.com" });
    const c1 = await claimFound(owner, first);
    const c2 = await claimFound(owner, second);
    await finder.post(`/api/claims/${c1.id}/accept`).send({}).expect(200);
    await finder.post(`/api/claims/${c2.id}/accept`).send({}).expect(200);
    await connect(owner, c1.id);
    assert.equal((await owner.get(`/api/conversations/${c1.conversationId}`)).body.conversation.locked, false);
    assert.equal((await owner.get(`/api/conversations/${c2.conversationId}`)).body.conversation.locked, true);
    assert.equal((await owner.post(`/api/conversations/${c2.conversationId}/messages`).send({ body: "x" })).status, 402);
  });

  test("duplicate and concurrent claim actions stay consistent", async () => {
    const reporter = await ctx.agent({ email: "race@example.com" });
    const item = await createItem(reporter, { type: "found", title: "Black umbrella", category: "other" });
    const a = await ctx.agent({ email: "race-a@example.com" });
    const b = await ctx.agent({ email: "race-b@example.com" });
    const body = { answer: "It has a wooden handle", acceptReward: true, expectedRewardPaise: 35000 };

    const [s1, s2] = await Promise.all([a.post(`/api/items/${item.id}/claims`).send(body), a.post(`/api/items/${item.id}/claims`).send(body)]);
    assert.deepEqual([s1.status, s2.status].sort(), [200, 201]);
    assert.equal(s1.body.claim.id, s2.body.claim.id);
    const claimB = await claimFound(b, item, "Mine has a hook");

    const results = await Promise.all([reporter.post(`/api/claims/${s1.body.claim.id}/accept`).send({}), reporter.post(`/api/claims/${claimB.id}/accept`).send({})]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM claims WHERE item_id = $1 AND status = 'accepted'", [item.id]);
    assert.equal(rows[0].n, 1);
    const winner = results.find((r) => r.status === 200).body.claim.id;
    assert.equal((await reporter.post(`/api/claims/${winner}/accept`).send({}).expect(200)).body.changed, false);

    // The finder (poster) can no longer mark it returned; the owner confirms receipt.
    assert.equal((await reporter.post(`/api/items/${item.id}/status`).send({ status: "returned" })).status, 409);
    const winnerAgent = winner === s1.body.claim.id ? a : b;
    await connect(winnerAgent, winner);
    await winnerAgent.post(`/api/claims/${winner}/return`).send({}).expect(200);
    const statuses = (await ctx.pool.query("SELECT status FROM claims WHERE item_id = $1 ORDER BY id", [item.id])).rows.map((r) => r.status);
    assert.deepEqual(statuses.sort(), ["accepted", "superseded"]);
  });

  test("message retries with the same clientId create one message and one notification", async () => {
    const reporter = await ctx.agent({ email: "dedupe-r@example.com" });
    const item = await createItem(reporter, { type: "found", title: "Silver ring", category: "jewelry" });
    const other = await ctx.agent({ email: "dedupe-o@example.com" });
    const claim = await claimFound(other, item);
    await reporter.post(`/api/claims/${claim.id}/accept`).send({}).expect(200);
    await connect(other, claim.id);
    const clientId = crypto.randomUUID();
    const sends = await Promise.all(
      [1, 2, 3].map(() => other.post(`/api/conversations/${claim.conversationId}/messages`).send({ body: "Is it the silver one?", clientId }))
    );
    assert.ok(sends.every((r) => r.status === 201));
    assert.equal(new Set(sends.map((r) => r.body.message.id)).size, 1);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'message'", [reporter.user.id]);
    assert.equal(rows[0].n, 1);
  });
});

describe("matching", () => {
  test("a new found listing notifies the owner of a similar lost listing once", async () => {
    const loser = await ctx.agent({ email: "loser@example.com" });
    const lost = await createItem(loser, { type: "lost", title: "Samsung Galaxy S23 phone", category: "phone", location: "FC Road Pune" });
    const finder = await ctx.agent({ email: "matchfinder@example.com" });
    const found = await createItem(finder, { type: "found", title: "Samsung Galaxy phone", category: "phone", location: "FC Road" });
    // Editing the found listing re-runs matching; dedupe keeps one notification.
    await finder.patch(`/api/items/${found.id}`).field("description", "Black case").expect(200);

    const matches = await ctx.pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'match'", [loser.user.id]);
    assert.equal(matches.rows[0].n, 1);
    const list = await loser.get(`/api/items/${lost.id}/matches`).expect(200);
    assert.equal(list.body.matches[0].item.id, found.id);
  });
});

describe("moderation", () => {
  test("report, remove and restore with audit trail and public effect", async () => {
    const owner = await ctx.agent({ email: "spammer@example.com" });
    const item = await createItem(owner, { title: "Cheap watches for sale", category: "other" }, [await pngImage()]);
    const reporter = await ctx.agent({ email: "flagger@example.com" });
    await reporter.post(`/api/items/${item.id}/reports`).send({ reason: "spam", details: "Advert" }).expect(201);
    const again = await reporter.post(`/api/items/${item.id}/reports`).send({ reason: "spam" }).expect(200);
    assert.equal(again.body.alreadyReported, true);

    const mod = await ctx.agent({ email: "mod@example.com", role: "moderator" });
    const queue = await mod.get("/api/moderation/queue").expect(200);
    assert.ok(queue.body.entries.some((e) => e.item.id === item.id && e.reports.length === 1));

    await mod.post(`/api/moderation/items/${item.id}/remove`).send({ reason: "Commercial spam" }).expect(200);
    const anon = ctx.anonymous();
    assert.equal((await anon.get(`/api/items/${item.id}`)).status, 410);
    assert.equal((await anon.get(item.images[0].url)).status, 404);
    assert.equal((await anon.get("/api/items?q=watches")).body.total, 0);
    // Owner and moderator can still see it.
    assert.equal((await owner.get(`/api/items/${item.id}`)).body.item.moderationState, "removed");
    assert.equal((await owner.get(item.images[0].url)).status, 200);
    assert.ok((await owner.get("/api/notifications")).body.notifications.some((n) => n.type === "listing_removed"));

    const actions = await mod.get("/api/moderation/actions").expect(200);
    assert.ok(actions.body.actions.some((a) => a.itemId === item.id && a.action === "remove_listing" && a.reason === "Commercial spam"));

    await mod.post(`/api/moderation/items/${item.id}/restore`).send({ reason: "Appeal accepted" }).expect(200);
    assert.equal((await anon.get(`/api/items/${item.id}`)).status, 200);
  });
});
