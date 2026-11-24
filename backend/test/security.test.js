"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { loadConfig } = require("../src/config");
const { setup, pngImage, jpegWithGps, storedFiles, createItem, testEnv, claimFound } = require("./helpers");

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.teardown());

const FORBIDDEN_KEYS = ["email", "user_email", "mobile_number", "user_mobile_number", "phone", "answer", "latitude", "longitude", "storage_key", "user_id", "google_id"];

function assertNoPrivateFields(value, where) {
  const text = JSON.stringify(value);
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(!new RegExp(`"${key}":`).test(text), `${where} leaked "${key}": ${text.slice(0, 300)}`);
  }
}

describe("configuration guards", () => {
  test("refuses to start without a strong session secret", () => {
    assert.throws(() => loadConfig({ ...testEnv(), SESSION_SECRET: "short" }), /SESSION_SECRET/);
  });

  test("test auth fixture cannot be enabled outside NODE_ENV=test", () => {
    assert.throws(() => loadConfig({ ...testEnv(), NODE_ENV: "production" }), /ENABLE_TEST_AUTH/);
    assert.throws(() => loadConfig({ ...testEnv(), NODE_ENV: "development" }), /ENABLE_TEST_AUTH/);
  });

  test("secure cookies are on automatically for an HTTPS app URL", () => {
    const config = loadConfig({ ...testEnv(), ENABLE_TEST_AUTH: "", NODE_ENV: "production", APP_URL: "https://lostfound.example", ALLOW_TEST_PAYMENTS: "true" });
    assert.equal(config.session.secureCookie, true);
    assert.equal(config.enableTestAuth, false);
  });
});

describe("public responses never expose private data", () => {
  test("listing, detail and search omit email, phone, coordinates and claim answers", async () => {
    const owner = await ctx.agent({ email: "owner-private@example.com", name: "Priya Sharma" });
    await owner.patch("/api/account/profile").send({ phone: "98765 43210", phoneCountry: "IN" }).expect(200);
    const item = await createItem(owner, {
      type: "found",
      title: "Silver iPhone",
      category: "phone",
      latitude: "18.528912",
      longitude: "73.874431",
      ownershipQuestion: "What is the lock screen photo?",
    });
    const claimant = await ctx.agent({ email: "claimant-private@example.com" });
    await claimFound(claimant, item, "My dog Bruno");

    const anon = ctx.anonymous();
    const list = await anon.get("/api/items?type=found").expect(200);
    const detail = await anon.get(`/api/items/${item.id}`).expect(200);
    assertNoPrivateFields(list.body, "search");
    assertNoPrivateFields(detail.body, "detail");
    assert.equal(detail.body.item.reporter.displayName, "Priya S.");
    assert.equal(detail.body.item.approxLatitude, 18.53);
    assert.ok(!JSON.stringify(detail.body).includes("My dog Bruno"));
    assert.ok(!JSON.stringify(detail.body).includes("98765"));

    // Another signed-in user sees the same public shape.
    const third = await ctx.agent({ email: "third-private@example.com" });
    assertNoPrivateFields((await third.get(`/api/items/${item.id}`).expect(200)).body.item, "detail (third user)");
  });
});

describe("CSRF, origins and logout", () => {
  test("state-changing requests need the session CSRF token", async () => {
    const http = await ctx.agent({ email: "csrf@example.com" });
    const res = await ctx.anonymous().post("/api/notifications/read").send({});
    assert.equal(res.status, 403);
    // Same session, wrong token.
    const wrong = await http.post("/api/notifications/read").set("X-CSRF-Token", "x".repeat(43)).send({});
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, "csrf_invalid");
  });

  test("cross-origin requests are rejected even with a valid token", async () => {
    const http = await ctx.agent({ email: "origin@example.com" });
    const res = await http.post("/api/notifications/read").set("Origin", "https://evil.example").send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "csrf_origin");
  });

  test("logout is POST-only and ends the session", async () => {
    const http = await ctx.agent({ email: "logout@example.com" });
    assert.equal((await http.get("/api/auth/logout")).status, 404);
    await http.post("/api/auth/logout").expect(200);
    const me = await http.get("/api/auth/me").expect(200);
    assert.equal(me.body.loggedIn, false);
  });

  test("login rotates the session identifier", async () => {
    const supertest = require("supertest");
    const http = supertest.agent(ctx.app);
    const first = await http.get("/api/auth/me");
    const before = first.headers["set-cookie"]?.[0]?.split(";")[0];
    const login = await http
      .post("/api/auth/test-login")
      .set("X-CSRF-Token", first.body.csrfToken)
      .send({ email: "rotate@example.com", name: "Rotate" })
      .expect(200);
    const afterCookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(before && afterCookie && before !== afterCookie, "session cookie should change on login");
    assert.notEqual(login.body.csrfToken, first.body.csrfToken);
  });

  test("security headers are present and X-Powered-By is gone", async () => {
    const res = await ctx.anonymous().get("/api/stats").expect(200);
    assert.equal(res.headers["x-powered-by"], undefined);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
    assert.ok(res.headers["x-request-id"]);
  });
});

describe("uploads", () => {
  test("valid images are re-encoded to WebP with metadata stripped", async () => {
    const http = await ctx.agent({ email: "uploader@example.com" });
    const item = await createItem(http, {}, [await jpegWithGps(), await pngImage()]);
    assert.equal(item.images.length, 2);
    const res = await ctx.anonymous().get(item.images[0].url).expect(200);
    assert.equal(res.headers["content-type"], "image/webp");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["content-security-policy"], /sandbox/);
    const meta = await sharp(res.body).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.exif, undefined, "EXIF must be stripped");
    const thumb = await ctx.anonymous().get(item.images[0].thumbUrl).expect(200);
    assert.equal((await sharp(thumb.body).metadata()).width, 480);
  });

  test("an HTML file disguised as an image is rejected and nothing is stored", async () => {
    const http = await ctx.agent({ email: "attacker@example.com" });
    const beforeFiles = storedFiles(ctx.storageDir).length;
    const beforeItems = (await ctx.pool.query("SELECT count(*)::int AS n FROM items")).rows[0].n;
    const res = await http
      .post("/api/items")
      .field("type", "lost")
      .field("title", "Evil")
      .field("category", "other")
      .field("location", "Somewhere")
      .field("date", new Date().toISOString().slice(0, 10))
      .field("acceptRewardTerms", "true")
      .field("expectedRewardPaise", "35000")
      .attach("images", Buffer.from("<html><script>alert(document.cookie)</script></html>"), {
        filename: "photo.png",
        contentType: "image/png",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid_image");
    assert.equal(storedFiles(ctx.storageDir).length, beforeFiles);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM items")).rows[0].n, beforeItems);
  });

  test("a good image followed by a bad one leaves no partial upload", async () => {
    const http = await ctx.agent({ email: "mixed@example.com" });
    const beforeFiles = storedFiles(ctx.storageDir).length;
    const res = await http
      .post("/api/items")
      .field("type", "lost")
      .field("title", "Mixed")
      .field("category", "other")
      .field("location", "Somewhere")
      .field("date", new Date().toISOString().slice(0, 10))
      .field("acceptRewardTerms", "true")
      .field("expectedRewardPaise", "35000")
      .attach("images", await pngImage(), "ok.png")
      .attach("images", Buffer.from("GIF89a not really"), "bad.gif");
    assert.equal(res.status, 400);
    assert.equal(storedFiles(ctx.storageDir).length, beforeFiles);
  });

  test("oversized files, too many files and tiny images are rejected", async () => {
    const http = await ctx.agent({ email: "limits@example.com" });
    const base = () =>
      http
        .post("/api/items")
        .field("type", "lost")
        .field("title", "Limits")
        .field("category", "other")
        .field("location", "Somewhere")
        .field("date", new Date().toISOString().slice(0, 10))
        .field("acceptRewardTerms", "true")
        .field("expectedRewardPaise", "35000");

    const huge = Buffer.alloc(ctx.config.uploads.maxFileBytes + 1024, 1);
    const big = await base().attach("images", huge, "huge.png");
    assert.equal(big.status, 413);

    let many = base();
    const img = await pngImage();
    for (let i = 0; i < 6; i++) many = many.attach("images", img, `p${i}.png`);
    assert.equal((await many).status, 400);

    const tiny = await base().attach("images", await pngImage(8, 8), "tiny.png");
    assert.equal(tiny.status, 400);
  });

  test("database failure after storing images cleans up the stored files", async () => {
    const http = await ctx.agent({ email: "dbfail@example.com" });
    const beforeFiles = storedFiles(ctx.storageDir).length;
    // Force the INSERT to fail with a temporary constraint.
    await ctx.pool.query("ALTER TABLE items ADD CONSTRAINT test_reject_title CHECK (name <> 'Reject me')");
    try {
      const res = await http
        .post("/api/items")
        .field("type", "lost")
        .field("title", "Reject me")
        .field("category", "other")
        .field("location", "Somewhere")
        .field("date", new Date().toISOString().slice(0, 10))
        .field("acceptRewardTerms", "true")
        .field("expectedRewardPaise", "35000")
        .attach("images", await pngImage(), "ok.png");
      assert.equal(res.status, 500);
      assert.equal(storedFiles(ctx.storageDir).length, beforeFiles);
    } finally {
      await ctx.pool.query("ALTER TABLE items DROP CONSTRAINT test_reject_title");
    }
  });

  test("legacy /uploads paths are never served", async () => {
    assert.equal((await ctx.anonymous().get("/uploads/1700000000.html")).status, 410);
    assert.equal((await ctx.anonymous().get("/api/uploads/x.png")).status, 410);
  });
});

describe("rate limiting", () => {
  test("returns 429 once a limit is exceeded", async () => {
    const limited = await setup({ RATE_LIMIT_MULTIPLIER: "0.2" }); // otp-request limit becomes 1
    try {
      const http = await limited.agent();
      const first = await http.post("/api/auth/email/request").send({ email: "rl@example.com" });
      assert.equal(first.status, 202);
      const second = await http.post("/api/auth/email/request").send({ email: "rl2@example.com" });
      assert.equal(second.status, 429);
      assert.equal(second.body.error.code, "rate_limited");
    } finally {
      await limited.teardown();
    }
  });
});

describe("probes", () => {
  test("liveness and readiness", async () => {
    await ctx.anonymous().get("/healthz").expect(200);
    const ready = await ctx.anonymous().get("/readyz").expect(200);
    assert.equal(ready.body.status, "ready");
  });
});
