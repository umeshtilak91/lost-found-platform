"use strict";

// Integration test harness: each test file gets its own freshly migrated
// PostgreSQL database and storage directory, so files are isolated and the
// developer's databases and volumes are never touched.
//
// Requires TEST_DATABASE_URL pointing at a server where the user may CREATE
// DATABASE (default: postgres://postgres:test@localhost:5544/postgres).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const sharp = require("sharp");
const supertest = require("supertest");

const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { createPool } = require("../src/db");
const { runMigrations } = require("../src/migrate");
const { createStorage } = require("../src/integrations/storage");
const { createApp } = require("../src/app");
const { rewardFor } = require("../src/config/pricing");

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:test@localhost:5544/postgres";

async function createDatabase() {
  const name = `lf_test_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      const pool = new Pool({ connectionString: ADMIN_URL });
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await pool.end();
    },
  };
}

function testEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    ENABLE_TEST_AUTH: "true",
    SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    APP_URL: "http://localhost:3000",
    LOG_LEVEL: "silent",
    RATE_LIMIT_MULTIPLIER: "100",
    ...overrides,
  };
}

// Captures outbound email instead of sending it.
// Test-only email adapter: captures messages; `mode` simulates provider outcomes.
function createCapturingMailer() {
  const sent = [];
  const mailer = {
    sent,
    mode: "sent", // "sent" | "failed" | "unconfirmed"
    configured: true,
    provider: "test",
    async send(message) {
      if (mailer.mode === "failed") return { status: "failed", provider: "test", error: "validation_error: simulated rejection" };
      sent.push(message);
      if (mailer.mode === "unconfirmed") return { status: "unconfirmed", provider: "test", error: "timeout" };
      return { status: "sent", provider: "test", messageId: `test-msg-${sent.length}` };
    },
  };
  return mailer;
}

async function setup(envOverrides = {}) {
  const db = await createDatabase();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-storage-"));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-legacy-"));
  const config = loadConfig(
    testEnv({ DATABASE_URL: db.url, STORAGE_LOCAL_DIR: storageDir, LEGACY_UPLOADS_DIR: legacyDir, ...envOverrides })
  );
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  await runMigrations(pool, logger);
  const storage = createStorage(config.storage, logger);
  const mailer = createCapturingMailer();
  const app = createApp({ config, pool, logger, storage, mailer });

  async function agent(user) {
    const http = supertest.agent(app);
    const me = await http.get("/api/auth/me");
    let csrf = me.body.csrfToken;
    if (user) {
      const res = await http
        .post("/api/auth/test-login")
        .set("X-CSRF-Token", csrf)
        .send({ email: user.email, name: user.name || user.email.split("@")[0], role: user.role || "user" });
      if (res.status !== 200) throw new Error(`test-login failed: ${res.status} ${JSON.stringify(res.body)}`);
      csrf = res.body.csrfToken;
      http.user = res.body.user;
    }
    // Wrap mutating verbs so every request carries the CSRF token.
    for (const verb of ["post", "patch", "delete", "put"]) {
      const original = http[verb].bind(http);
      http[verb] = (url) => original(url).set("X-CSRF-Token", csrf);
    }
    http.csrf = () => csrf;
    return http;
  }

  return {
    app,
    config,
    pool,
    storage,
    storageDir,
    legacyDir,
    mailer,
    agent,
    anonymous: () => supertest(app),
    async teardown() {
      await pool.end();
      await db.drop();
      fs.rmSync(storageDir, { recursive: true, force: true });
      fs.rmSync(legacyDir, { recursive: true, force: true });
    },
  };
}

async function pngImage(width = 200, height = 150, color = { r: 200, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function jpegWithGps() {
  return sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "secret-owner-tag" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "18/1 31/1 0/1" } })
    .toBuffer();
}

function storedFiles(dir) {
  const out = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Creates a listing via the API with sensible defaults. Lost listings include
// the owner's reward acknowledgement for the category's current amount.
async function createItem(http, fields = {}, images = []) {
  let req = http.post("/api/items");
  const body = { type: "lost", title: "Black leather wallet", category: "wallet", location: "Pune Railway Station", date: today(), ...fields };
  if (body.type === "lost" && body.acceptRewardTerms === undefined) {
    body.acceptRewardTerms = "true";
    body.expectedRewardPaise = String(rewardFor(body.category));
  }
  for (const [key, value] of Object.entries(body)) req = req.field(key, String(value));
  for (const [index, buffer] of images.entries()) req = req.attach("images", buffer, `photo-${index}.png`);
  const res = await req;
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item;
}

// Claim a FOUND listing as its owner (accepting the current category reward).
async function claimFound(http, item, answer = "It has my initials inside") {
  const res = await http.post(`/api/items/${item.id}/claims`).send({ answer, acceptReward: true, expectedRewardPaise: rewardFor(item.category) });
  if (![200, 201].includes(res.status)) throw new Error(`claim failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.claim;
}

// Owner pays the ₹100 connection fee through the local test-mode provider.
async function connect(ownerHttp, claimId, outcome = "success") {
  const checkout = await ownerHttp.post(`/api/claims/${claimId}/checkout`).send({});
  if (checkout.status !== 200) throw new Error(`checkout failed ${checkout.status} ${JSON.stringify(checkout.body)}`);
  const { orderId } = checkout.body.checkout;
  const done = await ownerHttp.post("/api/payments/test/complete").send({ orderId, outcome });
  const verify = await ownerHttp.post("/api/payments/verify").send({ orderId, paymentId: done.body.paymentId, signature: done.body.signature });
  return { checkout: checkout.body.checkout, payment: done.body, verify };
}

module.exports = { setup, claimFound, connect, createDatabase, testEnv, pngImage, jpegWithGps, storedFiles, createItem, today, daysAgo, ADMIN_URL };
