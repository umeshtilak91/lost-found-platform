"use strict";

const pino = require("pino");

// Paths that must never reach log output. Request bodies are not logged at all;
// these cover headers and any object that a handler logs explicitly.
const REDACT = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.code",
  "*.answer",
  "*.body",
  "*.email",
  "*.mobile_number",
  "*.profile",
];

function createLogger(config) {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { service: "lost-found-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
