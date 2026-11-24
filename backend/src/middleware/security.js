"use strict";

const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");
const { HttpError } = require("./errors");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// CSRF: synchronizer token stored in the session and echoed in X-CSRF-Token,
// plus an Origin/Referer allow-list check for every state-changing request.
// ---------------------------------------------------------------------------
function issueCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  return req.session.csrfToken;
}

function csrfProtection(config, { exempt = [] } = {}) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || exempt.some((prefix) => req.path.startsWith(prefix))) return next();

    let origin = req.get("origin") || null;
    if (!origin && req.get("referer")) {
      try {
        origin = new URL(req.get("referer")).origin;
      } catch {
        origin = "invalid";
      }
    }
    if (origin && !config.allowedOrigins.includes(origin)) {
      return next(new HttpError(403, "Request origin is not allowed", "csrf_origin"));
    }

    const expected = req.session?.csrfToken;
    const provided = req.get("x-csrf-token");
    if (
      !expected ||
      !provided ||
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    ) {
      return next(new HttpError(403, "Your session has expired. Refresh the page and try again.", "csrf_invalid"));
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting with counters in PostgreSQL so limits hold across replicas.
// ---------------------------------------------------------------------------
class PgRateLimitStore {
  constructor(pool, prefix) {
    this.pool = pool;
    this.prefix = prefix;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [`${this.prefix}:${key}`, String(this.windowMs)]
    );
    return { totalHits: rows[0].hits, resetTime: rows[0].reset_at };
  }

  async decrement(key) {
    await this.pool.query("UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1", [
      `${this.prefix}:${key}`,
    ]);
  }

  async resetKey(key) {
    await this.pool.query("DELETE FROM rate_limits WHERE key = $1", [`${this.prefix}:${key}`]);
  }
}

function createRateLimiters(pool, config) {
  const make = (name, windowMinutes, limit, keyByUser = false) =>
    rateLimit({
      windowMs: windowMinutes * 60 * 1000,
      limit: Math.max(1, Math.round(limit * config.rateLimitMultiplier)),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      store: new PgRateLimitStore(pool, name),
      // Authenticated actions are limited per account; anonymous ones per IP.
      keyGenerator: (req) => (keyByUser && req.user ? `u${req.user.id}` : `ip${req.ip}`),
      validate: { keyGeneratorIpFallback: false },
      handler: (req, res) =>
        res.status(429).json({
          error: { code: "rate_limited", message: "Too many requests. Please wait a few minutes and try again." },
        }),
    });

  return {
    general: make("general", 1, 300),
    auth: make("auth", 15, 30),
    otpRequest: make("otp-request", 15, 5),
    otpVerify: make("otp-verify", 15, 15),
    report: make("report", 60, 20, true),
    upload: make("upload", 60, 40, true),
    contact: make("contact", 10, 60, true),
    claim: make("claim", 60, 20, true),
    abuse: make("abuse", 60, 20, true),
    places: make("places", 1, 60, true),
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
function requireUser(req, res, next) {
  if (req.isAuthenticated?.() && req.user) return next();
  return next(new HttpError(401, "Please sign in to continue", "auth_required"));
}

function requireModerator(req, res, next) {
  if (!req.user) return next(new HttpError(401, "Please sign in to continue", "auth_required"));
  if (!["moderator", "admin"].includes(req.user.role)) {
    return next(new HttpError(403, "Moderator access required", "forbidden"));
  }
  return next();
}

module.exports = {
  issueCsrfToken,
  csrfProtection,
  createRateLimiters,
  PgRateLimitStore,
  requireUser,
  requireModerator,
};
