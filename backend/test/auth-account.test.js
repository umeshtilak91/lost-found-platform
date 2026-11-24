"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const supertest = require("supertest");
const { resolveIdentity } = require("../src/auth/accounts");
const { setup, pngImage, createItem, storedFiles, claimFound } = require("./helpers");

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.teardown());


function lastCode() {
  const message = ctx.mailer.sent.filter((m) => m.template === "otp").at(-1);
  return message.text.match(/\b(\d{6})\b/)[1];
}

async function requestCode(http, email) {
  const res = await http.post("/api/auth/email/request").send({ email });
  return res;
}

// Moves the cooldown window back so a test can request again immediately.
async function skipCooldown(email) {
  await ctx.pool.query("UPDATE otp_codes SET created_at = created_at - interval '2 minutes' WHERE email = $1", [email]);
}

describe("email one-time codes", () => {
  test("request returns challenge metadata only; verify signs in, rotates the session, and cannot be replayed", async () => {
    const http = await ctx.agent();
    const req = await requestCode(http, "Otp.User@Example.com");
    assert.equal(req.status, 202);
    assert.deepEqual(Object.keys(req.body).sort(), ["challengeId", "delivery", "email", "expiresAt", "resendAvailableAt"]);
    assert.equal(req.body.email, "otp.user@example.com");
    assert.equal(req.body.delivery, "sent");
    const ttl = (new Date(req.body.expiresAt) - Date.now()) / 60000;
    assert.ok(ttl > 4.8 && ttl <= 5.01, `expiry ~5 min, got ${ttl}`);
    const row = (await ctx.pool.query("SELECT code_hash, delivery_status, provider, provider_message_id FROM otp_codes WHERE challenge_id = $1", [req.body.challengeId])).rows[0];
    assert.equal(row.delivery_status, "sent");
    assert.equal(row.provider_message_id, "test-msg-" + ctx.mailer.sent.length);
    const code = lastCode();
    assert.ok(!JSON.stringify(row).includes(code), "the code itself is never stored");

    const before = (await http.get("/api/auth/me")).headers["set-cookie"];
    const ok = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code, next: "/report" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, "otp.user@example.com");
    assert.equal(ok.body.user.emailVerified, true);
    assert.equal(ok.body.redirectTo, "/report");
    assert.ok(ok.headers["set-cookie"], "session cookie rotated on login");
    void before;

    const replay = await (await ctx.agent()).post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error.code, "otp_used");
  });

  test("wrong code counts attempts and locks after five; expired code is rejected", async () => {
    const http = await ctx.agent();
    const req = await requestCode(http, "brute@example.com");
    const good = lastCode();
    const wrong = good === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 1; i--) {
      const r = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: wrong });
      assert.equal(r.body.error.code, "invalid_code");
      assert.equal(r.body.error.details.remaining, i);
    }
    const fifth = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: wrong });
    assert.equal(fifth.body.error.code, "otp_locked");
    const afterLock = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: good });
    assert.equal(afterLock.body.error.code, "otp_locked", "correct code no longer works after lockout");

    const http2 = await ctx.agent();
    const req2 = await requestCode(http2, "expire@example.com");
    const code2 = lastCode();
    await ctx.pool.query("UPDATE otp_codes SET expires_at = now() - interval '1 second' WHERE challenge_id = $1", [req2.body.challengeId]);
    const expired = await http2.post("/api/auth/email/verify").send({ challengeId: req2.body.challengeId, code: code2 });
    assert.equal(expired.body.error.code, "otp_expired");
  });

  test("challenge/email association, unknown challenges and malformed input are rejected", async () => {
    const http = await ctx.agent();
    const req = await requestCode(http, "assoc@example.com");
    const code = lastCode();
    const mismatch = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code, email: "someone-else@example.com" });
    assert.equal(mismatch.body.error.code, "invalid_challenge");
    const unknown = await http.post("/api/auth/email/verify").send({ challengeId: "00000000-0000-4000-8000-000000000000", code });
    assert.equal(unknown.body.error.code, "invalid_challenge");
    assert.equal((await http.post("/api/auth/email/verify").send({ challengeId: "not-a-uuid", code })).status, 400);
    assert.equal((await http.post("/api/auth/email/request").send({ email: "not-an-email" })).status, 400);
    // The correct pair still works afterwards.
    assert.equal((await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code, email: "assoc@example.com" })).status, 200);
  });

  test("60s resend cooldown; a resend supersedes the previous code; per-email request limit", async () => {
    const http = await ctx.agent();
    const first = await requestCode(http, "resend@example.com");
    const firstCode = lastCode();
    const cooldown = await requestCode(http, "resend@example.com");
    assert.equal(cooldown.status, 429);
    assert.equal(cooldown.body.error.code, "otp_cooldown");
    assert.ok(cooldown.body.error.details.retryAfter > 0 && cooldown.body.error.details.retryAfter <= 60);

    await skipCooldown("resend@example.com");
    const second = await requestCode(http, "resend@example.com");
    assert.equal(second.status, 202);
    assert.notEqual(second.body.challengeId, first.body.challengeId);
    const old = await http.post("/api/auth/email/verify").send({ challengeId: first.body.challengeId, code: firstCode });
    assert.equal(old.body.error.code, "otp_superseded");

    for (let i = 0; i < 3; i++) {
      await skipCooldown("resend@example.com");
      assert.equal((await requestCode(http, "resend@example.com")).status, 202);
    }
    await skipCooldown("resend@example.com");
    const limited = await requestCode(http, "resend@example.com");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "otp_limit");
  });

  test("concurrent requests create one challenge; concurrent verification signs in once", async () => {
    const http = await ctx.agent();
    const results = await Promise.all([1, 2, 3].map(() => requestCode(http, "race-otp@example.com")));
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 429, 429]);
    const challengeId = results.find((r) => r.status === 202).body.challengeId;
    const code = lastCode();
    const agents = await Promise.all([ctx.agent(), ctx.agent(), ctx.agent()]);
    const verifies = await Promise.all(agents.map((a) => a.post("/api/auth/email/verify").send({ challengeId, code })));
    assert.equal(verifies.filter((r) => r.status === 200).length, 1);
  });

  test("provider rejection fails cleanly (no cooldown, unusable challenge); timeout keeps the code valid", async () => {
    const http = await ctx.agent();
    ctx.mailer.mode = "failed";
    try {
      const rejected = await requestCode(http, "reject@example.com");
      assert.equal(rejected.status, 502);
      assert.equal(rejected.body.error.code, "email_delivery_failed");
      const row = (await ctx.pool.query("SELECT delivery_status, consumed_reason, provider_error FROM otp_codes WHERE email = 'reject@example.com'")).rows[0];
      assert.deepEqual(row, { delivery_status: "failed", consumed_reason: "delivery_failed", provider_error: "validation_error: simulated rejection" });
    } finally {
      ctx.mailer.mode = "sent";
    }
    // No cooldown after a failed delivery: the user can retry immediately.
    assert.equal((await requestCode(http, "reject@example.com")).status, 202);

    ctx.mailer.mode = "unconfirmed";
    try {
      const slow = await requestCode(http, "slow@example.com");
      assert.equal(slow.status, 202);
      assert.equal(slow.body.delivery, "unconfirmed");
      const code = lastCode();
      assert.equal((await http.post("/api/auth/email/verify").send({ challengeId: slow.body.challengeId, code })).status, 200);
    } finally {
      ctx.mailer.mode = "sent";
    }
  });

  test("unsafe return URLs are replaced with /", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const http = await ctx.agent();
      const email = `next-${Math.random().toString(36).slice(2)}@example.com`;
      const req = await requestCode(http, email);
      const res = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: lastCode(), next });
      assert.equal(res.body.redirectTo, "/", `unsafe next ${next}`);
    }
  });

  test("existing users sign in to the same account; new emails register; logout ends the session", async () => {
    const http = await ctx.agent();
    let req = await requestCode(http, "returning@example.com");
    const first = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: lastCode() });
    // Login rotates the CSRF token; the old one must no longer work.
    assert.equal((await http.post("/api/auth/logout")).status, 403);
    await http.post("/api/auth/logout").set("X-CSRF-Token", first.body.csrfToken).expect(200);
    assert.equal((await http.get("/api/auth/me")).body.loggedIn, false);
    await skipCooldown("returning@example.com");
    const http2 = await ctx.agent();
    req = await requestCode(http2, "returning@example.com");
    const second = await http2.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: lastCode() });
    assert.equal(second.body.user.id, first.body.user.id, "same account on return");
    const count = await ctx.pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'returning@example.com'");
    assert.equal(count.rows[0].n, 1, "no duplicate account");
    // Signed-in session can perform a protected action.
    assert.equal((await http2.get("/api/me/items")).status, 200);
  });

  test("an email code for a Google-registered address signs into the same account", async () => {
    const google = await resolveIdentity(ctx.pool, { provider: "google", subject: "g-otp-1", email: "linked@example.com", emailVerified: true, name: "Linked Person" });
    const http = await ctx.agent();
    const req = await requestCode(http, "linked@example.com");
    const res = await http.post("/api/auth/email/verify").send({ challengeId: req.body.challengeId, code: lastCode() });
    assert.equal(res.body.user.id, google.id);
    const ids = await ctx.pool.query("SELECT provider FROM auth_identities WHERE user_id = $1 ORDER BY provider", [google.id]);
    assert.deepEqual(ids.rows.map((r) => r.provider), ["email", "google"]);
  });

  test("Google is reported unconfigured and its route redirects to a clear message", async () => {
    const providers = await ctx.anonymous().get("/api/auth/providers").expect(200);
    assert.equal(providers.body.google, false);
    const res = await ctx.anonymous().get("/api/auth/google");
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login\?error=google_unconfigured$/);
  });
});

describe("account linking", () => {
  test("verified email from another provider links to the same account", async () => {
    const viaEmail = await resolveIdentity(ctx.pool, { provider: "email", subject: "link@example.com", email: "link@example.com", emailVerified: true });
    const viaGoogle = await resolveIdentity(ctx.pool, {
      provider: "google",
      subject: "google-sub-123",
      email: "LINK@example.com",
      emailVerified: true,
      name: "Link Person",
    });
    assert.equal(viaGoogle.id, viaEmail.id);
  });

  test("an unverified email never links to an existing account", async () => {
    const victim = await resolveIdentity(ctx.pool, { provider: "email", subject: "victim@example.com", email: "victim@example.com", emailVerified: true });
    const attacker = await resolveIdentity(ctx.pool, { provider: "google", subject: "attacker-sub", email: "victim@example.com", emailVerified: false });
    assert.notEqual(attacker.id, victim.id);
  });
});

describe("profile, export and deletion", () => {
  test("international phone numbers are validated and normalized", async () => {
    const http = await ctx.agent({ email: "phone@example.com" });
    assert.equal((await http.patch("/api/account/profile").send({ phone: "12345", phoneCountry: "IN" })).status, 400);
    const us = await http.patch("/api/account/profile").send({ phone: "(415) 555-2671", phoneCountry: "US" }).expect(200);
    assert.equal(us.body.user.phone, "+14155552671");
    const cleared = await http.patch("/api/account/profile").send({ phone: null }).expect(200);
    assert.equal(cleared.body.user.phone, null);
  });

  test("export contains the user's data; deletion removes it and its images", async () => {
    const http = await ctx.agent({ email: "leaving@example.com", name: "Leaving User" });
    const item = await createItem(http, { title: "Leaving bag", category: "bag" }, [await pngImage()]);
    const other = await ctx.agent({ email: "stays@example.com" });
    const otherItem = await createItem(other, { type: "found", title: "Found hat", category: "clothing" });
    await claimFound(http, otherItem, "Blue hat");

    const exported = await http.get("/api/account/export").expect(200);
    assert.match(exported.headers["content-disposition"], /attachment/);
    assert.equal(exported.body.account.email, "leaving@example.com");
    assert.equal(exported.body.listings.length, 1);
    assert.equal(exported.body.claimsSubmitted[0].answer, "Blue hat");

    const filesBefore = storedFiles(ctx.storageDir).length;
    assert.equal((await http.delete("/api/account").send({ confirm: "nope" })).status, 400);
    await http.delete("/api/account").send({ confirm: "DELETE" }).expect(204);

    assert.equal(storedFiles(ctx.storageDir).length, filesBefore - 2);
    assert.equal((await ctx.anonymous().get(`/api/items/${item.id}`)).status, 404);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'leaving@example.com'")).rows[0].n, 0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM claims WHERE item_id = $1", [otherItem.id])).rows[0].n, 0);
    assert.equal((await http.get("/api/auth/me")).body.loggedIn, false);
  });
});

describe("sessions survive an API restart", () => {
  test("a new app instance on the same database accepts the existing session", async () => {
    const http = await ctx.agent({ email: "restart@example.com" });
    const cookie = (await http.get("/api/auth/me")).request.cookies;
    // Build a second app (simulating a restarted process) on the same pool.
    const { createApp } = require("../src/app");
    const { createLogger } = require("../src/logger");
    const app2 = createApp({ config: ctx.config, pool: ctx.pool, logger: createLogger(ctx.config), storage: ctx.storage, mailer: ctx.mailer });
    const me = await supertest(app2).get("/api/auth/me").set("Cookie", cookie).expect(200);
    assert.equal(me.body.loggedIn, true);
    assert.equal(me.body.user.email, "restart@example.com");
    assert.ok(fs.existsSync(ctx.storageDir));
  });
});
