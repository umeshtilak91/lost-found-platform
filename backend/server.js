"use strict";

// Entry point. `node server.js` serves the API; `node server.js migrate`
// applies database migrations and the legacy image backfill, then exits.

require("dotenv").config({ quiet: true });

const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");
const { createPool } = require("./src/db");
const { runMigrations } = require("./src/migrate");
const { createStorage } = require("./src/integrations/storage");
const { backfillLegacyImages } = require("./src/legacyImages");
const { createApp } = require("./src/app");
const { refreshProviderCoordinates } = require("./src/services/locations");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config, logger);

  if (process.argv[2] === "migrate") {
    const ran = await runMigrations(pool, logger);
    logger.info({ applied: ran }, ran.length ? "Migrations applied" : "Database already up to date");
    await backfillLegacyImages({ pool, storage: createStorage(config.storage, logger), config, logger });
    await pool.end();
    return;
  }

  const app = createApp({ config, pool, logger });
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, places: config.places.provider, google: Boolean(config.google), apple: Boolean(config.apple), emailLogin: config.emailLogin, storage: config.storage.driver },
      "API listening"
    );
  });

  // Hourly housekeeping: expired one-time codes and rate-limit windows.
  const housekeeping = setInterval(() => {
    pool
      .query(
        `WITH a AS (DELETE FROM otp_codes WHERE created_at < now() - interval '1 day'),
              b AS (DELETE FROM rate_limits WHERE reset_at < now() - interval '1 hour'),
              c AS (DELETE FROM analytics_salts WHERE day < (now() AT TIME ZONE 'UTC')::date - 1),
              d AS (DELETE FROM page_views WHERE day < (now() AT TIME ZONE 'UTC')::date - 400)
         SELECT 1`
      )
      .catch((error) => logger.warn({ err: { message: error.message } }, "Housekeeping failed"));
    // Owners who haven't confirmed a reported handover get a reminder (never an auto-confirmation).
    app.locals.returns.sendReturnReminders().catch((error) => logger.warn({ err: { message: error.message } }, "Return reminders failed"));
    // Provider (Google) coordinates older than the permitted cache window.
    refreshProviderCoordinates({ pool, places: app.locals.places, config, logger }).catch((error) =>
      logger.warn({ err: { message: error.message } }, "Coordinate refresh failed")
    );
  }, 60 * 60 * 1000);
  housekeeping.unref();

  // Graceful shutdown for rolling deploys.
  const shutdown = (signal) => {
    logger.info({ signal }, "Shutting down");
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", msg: error.message }));
  process.exit(1);
});
