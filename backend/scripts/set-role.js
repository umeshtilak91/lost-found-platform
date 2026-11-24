"use strict";

// Grants or revokes moderator/admin access:
//   node scripts/set-role.js someone@example.com moderator
require("dotenv").config({ quiet: true });
const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { createPool } = require("../src/db");

async function main() {
  const [email, role] = process.argv.slice(2);
  if (!email || !["user", "moderator", "admin"].includes(role)) {
    console.error("Usage: node scripts/set-role.js <email> <user|moderator|admin>");
    process.exit(2);
  }
  const config = loadConfig();
  const pool = createPool(config, createLogger(config));
  const { rowCount } = await pool.query("UPDATE users SET role = $1, updated_at = now() WHERE lower(email) = lower($2)", [role, email]);
  console.log(rowCount ? `Updated ${rowCount} account(s) to role ${role}` : "No account with that email. The user must sign in once first.");
  await pool.end();
  process.exit(rowCount ? 0 : 1);
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
