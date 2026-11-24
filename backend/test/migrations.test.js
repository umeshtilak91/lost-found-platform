"use strict";

// Upgrades a representative snapshot of the original prototype database
// (hand-created tables, unprefixed Indian phone numbers, a legacy upload
// directory containing both a real image and an HTML file) and checks that
// data survives, legacy images are converted, and the run is repeatable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const supertest = require("supertest");
const { Pool } = require("pg");
const { createDatabase, testEnv, pngImage } = require("./helpers");
const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { createPool } = require("../src/db");
const { runMigrations, pendingMigrations } = require("../src/migrate");
const { createStorage } = require("../src/integrations/storage");
const { backfillLegacyImages } = require("../src/legacyImages");
const { createApp } = require("../src/app");

const PROTOTYPE_SCHEMA = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    google_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    profile_image TEXT,
    mobile_number VARCHAR(15),
    allow_phone_contact BOOLEAN DEFAULT FALSE
  );
  CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    image VARCHAR(255),
    type VARCHAR(10) NOT NULL,
    user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO users (google_id, name, email, mobile_number, allow_phone_contact)
    VALUES ('g-1', 'Umesh Tilak', 'umesh@example.com', '9876543210', TRUE),
           ('g-2', 'Second User', 'second@example.com', NULL, FALSE);
  INSERT INTO items (name, location, date, description, image, type, user_id, created_at) VALUES
    ('iPhone 15 Pro', 'Pune Railway Station', '2026-07-28', 'Blue case', '1753680000000.png', 'lost', 1, '2026-07-28 10:00:00'),
    ('Wallet', 'Hinjewadi Phase 1', '2026-07-27', NULL, '1753680000001.html', 'found', 2, '2026-07-27 09:00:00'),
    ('Laptop Bag', 'Baner', '2026-07-26', NULL, 'missing.jpg', 'found', 2, '2026-07-26 08:00:00'),
    ('Umbrella', 'Aundh', '2026-07-25', NULL, NULL, 'lost', NULL, '2026-07-25 07:00:00');
`;

let db;
let pool;
let config;
let logger;
let storageDir;
let legacyDir;

before(async () => {
  db = await createDatabase();
  const raw = new Pool({ connectionString: db.url });
  await raw.query(PROTOTYPE_SCHEMA);
  // The prototype applied its two SQL files by hand.
  await raw.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "001_update_items_user_fk.sql"), "utf8"));
  await raw.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "002_add_item_type_check.sql"), "utf8"));
  await raw.end();

  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-mig-storage-"));
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-mig-legacy-"));
  fs.writeFileSync(path.join(legacyDir, "1753680000000.png"), await pngImage(640, 480));
  fs.writeFileSync(path.join(legacyDir, "1753680000001.html"), "<script>alert(1)</script>");

  config = loadConfig(testEnv({ DATABASE_URL: db.url, STORAGE_LOCAL_DIR: storageDir, LEGACY_UPLOADS_DIR: legacyDir }));
  logger = createLogger(config);
  pool = createPool(config, logger);
});

after(async () => {
  await pool.end();
  await db.drop();
  fs.rmSync(storageDir, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

test("prototype database upgrades in place and keeps its data", async () => {
  const applied = await runMigrations(pool, logger);
  assert.deepEqual(applied, ["000_base_schema", "001_update_items_user_fk", "002_add_item_type_check", "003_platform_core", "004_site_analytics", "005_rewards_and_paid_connections", "006_otp_challenges", "007_item_locations", "008_return_lifecycle"]);
  assert.deepEqual(await pendingMigrations(pool), []);

  const items = (await pool.query("SELECT id, name, status, category, moderation_state, created_at FROM items ORDER BY id")).rows;
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.status === "open" && i.category === "other" && i.moderation_state === "visible"));
  assert.ok(items[0].created_at instanceof Date);

  const users = (await pool.query("SELECT id, mobile_number, email_verified, role FROM users ORDER BY id")).rows;
  assert.equal(users[0].mobile_number, "+919876543210");
  assert.ok(users.every((u) => u.email_verified && u.role === "user"));
  const identities = (await pool.query("SELECT provider, subject FROM auth_identities ORDER BY user_id")).rows;
  assert.deepEqual(identities.map((i) => i.subject), ["g-1", "g-2"]);
});

test("legacy uploads: valid image converted, HTML rejected, missing skipped; originals kept", async () => {
  const storage = createStorage(config.storage, logger);
  const summary = await backfillLegacyImages({ pool, storage, config, logger });
  assert.deepEqual(summary, { converted: 1, missing: 1, rejected: 1 });
  assert.ok(fs.existsSync(path.join(legacyDir, "1753680000000.png")), "original file preserved");

  const again = await backfillLegacyImages({ pool, storage, config, logger });
  assert.equal(again.converted, 0, "backfill is idempotent");

  const app = createApp({ config, pool, logger, storage });
  const detail = await supertest(app).get("/api/items/1").expect(200);
  assert.equal(detail.body.item.images.length, 1);
  const image = await supertest(app).get(detail.body.item.images[0].url).expect(200);
  assert.equal(image.headers["content-type"], "image/webp");
  const wallet = await supertest(app).get("/api/items/2").expect(200);
  assert.equal(wallet.body.item.images.length, 0, "HTML upload is never exposed");
  assert.equal((await supertest(app).get("/uploads/1753680000001.html")).status, 410);
});

test("re-running migrations is a no-op", async () => {
  assert.deepEqual(await runMigrations(pool, logger), []);
});
