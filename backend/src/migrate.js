"use strict";

// Minimal, ordered SQL migration runner. Each file runs once inside its own
// transaction and is recorded in schema_migrations. A PostgreSQL advisory lock
// prevents two replicas (or a Job and a Pod) from migrating at the same time.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK_ID = 74_211_903;

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return { id: file.replace(/\.sql$/, ""), sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    });
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function runMigrations(pool, logger = console) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await ensureTable(client);
    const applied = new Map(
      (await client.query("SELECT id, checksum FROM schema_migrations")).rows.map((row) => [row.id, row.checksum])
    );

    const ran = [];
    for (const migration of listMigrations()) {
      if (applied.has(migration.id)) {
        if (applied.get(migration.id) !== migration.checksum) {
          logger.warn({ migration: migration.id }, "Applied migration file has changed since it ran");
        }
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
          migration.id,
          migration.checksum,
        ]);
        await client.query("COMMIT");
        ran.push(migration.id);
        logger.info({ migration: migration.id }, "Applied migration");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        error.message = `Migration ${migration.id} failed: ${error.message}`;
        throw error;
      }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// Used by readiness checks: true only when every migration file is recorded.
async function pendingMigrations(pool) {
  const exists = await pool.query("SELECT to_regclass('public.schema_migrations') AS t");
  const files = listMigrations().map((m) => m.id);
  if (!exists.rows[0].t) return files;
  const done = new Set((await pool.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
  return files.filter((id) => !done.has(id));
}

module.exports = { runMigrations, pendingMigrations, listMigrations };
