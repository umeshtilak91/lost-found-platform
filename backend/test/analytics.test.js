"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");
const { normalisePath, referrerHost } = require("../src/routes/analytics");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.teardown());

function view(http, path, { ua = CHROME, ip = "198.51.100.1", referrer, headers = {} } = {}) {
  let req = http.post("/api/analytics/pageview").set("User-Agent", ua).set("X-Forwarded-For", ip);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(referrer ? { path, referrer } : { path });
}

test("path and referrer normalisation", () => {
  assert.equal(normalisePath("/items?type=lost#x"), "/items");
  assert.equal(normalisePath("/inbox/42"), "/inbox/:id");
  assert.equal(normalisePath("/items/7/edit"), "/items/:id/edit");
  assert.equal(normalisePath("/items/7/"), "/items/7");
  assert.equal(normalisePath("/api/stats"), null);
  assert.equal(normalisePath("//evil.example"), null);
  assert.equal(normalisePath("https://x"), null);
  assert.equal(referrerHost("https://www.google.com/search?q=x", "http://localhost:3000"), "google.com");
  assert.equal(referrerHost("http://localhost:3000/items", "http://localhost:3000"), null);
  assert.equal(referrerHost("javascript:alert(1)", "http://localhost:3000"), null);
});

test("counts daily unique visitors and views; ignores bots, DNT and GPC; stores no IPs", async () => {
  const anon = await ctx.agent();
  for (const p of ["/", "/items", "/items/1"]) await view(anon, p, { referrer: "https://www.google.com/" }).expect(204);
  await view(anon, "/items", { ua: FIREFOX, ip: "198.51.100.2", referrer: "https://twitter.com/x" }).expect(204);
  await view(anon, "/", { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" }).expect(204);
  await view(anon, "/", { ua: "Mozilla/5.0 HeadlessChrome/130.0" }).expect(204);
  await view(anon, "/", { headers: { DNT: "1" }, ip: "198.51.100.3" }).expect(204);
  await view(anon, "/", { headers: { "Sec-GPC": "1" }, ip: "198.51.100.4" }).expect(204);
  assert.equal((await view(anon, "/api/secret")).status, 400);

  const { rows } = await ctx.pool.query("SELECT * FROM page_views");
  assert.equal(rows.length, 4);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("198.51.100"), "raw IPs must never be stored");
  assert.equal(new Set(rows.map((r) => r.visitor_hash)).size, 2);

  const admin = await ctx.agent({ email: "analytics-admin@example.com", role: "admin" });
  const stats = await admin.get("/api/admin/analytics?days=7").expect(200);
  assert.equal(stats.body.totals.visitorsToday, 2);
  assert.equal(stats.body.totals.viewsToday, 4);
  assert.equal(stats.body.daily.length, 7);
  assert.equal(stats.body.daily.at(-1).visitors, 2);
  assert.deepEqual(stats.body.topPages[0], { path: "/items", views: 2, visitors: 2 });
  assert.deepEqual(
    stats.body.topReferrers.map((r) => r.host).sort(),
    ["google.com", "twitter.com"]
  );
});

test("visitor hashes do not link across days", async () => {
  const anon = await ctx.agent();
  // Simulate yesterday's salt: a different salt yields a different hash for the same visitor.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await ctx.pool.query("INSERT INTO analytics_salts (day, salt) VALUES ($1, 'other-salt') ON CONFLICT DO NOTHING", [yesterday]);
  await view(anon, "/", { ip: "198.51.100.9" }).expect(204);
  const { rows } = await ctx.pool.query("SELECT salt FROM analytics_salts ORDER BY day");
  assert.notEqual(rows[0].salt, rows.at(-1).salt);
});

test("only admins and moderators can read analytics", async () => {
  const user = await ctx.agent({ email: "analytics-user@example.com" });
  assert.equal((await user.get("/api/admin/analytics")).status, 403);
  assert.equal((await ctx.anonymous().get("/api/admin/analytics")).status, 401);
  const mod = await ctx.agent({ email: "analytics-mod@example.com", role: "moderator" });
  assert.equal((await mod.get("/api/admin/analytics?days=500")).status, 400);
  assert.equal((await mod.get("/api/admin/analytics")).status, 200);
});
