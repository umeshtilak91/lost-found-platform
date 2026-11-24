"use strict";

const { Pool, types } = require("pg");

// DATE columns are calendar dates with no timezone; keep them as YYYY-MM-DD
// strings instead of letting node-postgres shift them into local midnight.
types.setTypeParser(1082, (value) => value);

function createPool(config, logger) {
  const pool = new Pool(config.database);
  pool.on("error", (error) => logger.error({ err: error }, "Idle PostgreSQL client error"));
  return pool;
}

// Runs fn(client) inside a transaction and always releases the client.
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTransaction };
