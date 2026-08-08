const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "lost_found_db",
  password: "admin",
  port: 5434,
});

module.exports = pool;