"use strict";

// Central runtime configuration. Everything environment-specific is read here,
// validated once at startup, and passed around as a frozen object.

const path = require("path");

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  // Every problem is collected and reported together, naming the variable but
  // never echoing its value (values may be secrets).
  const problems = [];
  const fail = (message) => problems.push(message);
  const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      fail(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return parsed;
  };
  const nodeEnv = env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";

  const appUrl = (env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  if (!/^https?:\/\/[^/\s]+/.test(appUrl)) fail("APP_URL must be an absolute http(s) URL");
  const appIsHttps = appUrl.startsWith("https://");

  const sessionSecret = env.SESSION_SECRET || "";
  if (sessionSecret.length < 32) {
    fail("SESSION_SECRET must be set to at least 32 characters");
  }
  if (/change-me|replace-with/i.test(sessionSecret) && isProduction) {
    fail("SESSION_SECRET still contains a placeholder value");
  }

  const enableTestAuth = bool(env.ENABLE_TEST_AUTH);
  if (enableTestAuth && !isTest) {
    fail("ENABLE_TEST_AUTH is only permitted when NODE_ENV=test");
  }

  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const appleConfigured = Boolean(
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY
  );

  const storageDriver = env.STORAGE_DRIVER || "local";
  if (!["local", "s3"].includes(storageDriver)) {
    fail("STORAGE_DRIVER must be 'local' or 's3'");
  }
  if (storageDriver === "s3" && !env.S3_BUCKET) {
    fail("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }

  const paymentProvider = env.PAYMENT_PROVIDER || "test";
  if (!["test", "razorpay"].includes(paymentProvider)) fail("PAYMENT_PROVIDER must be 'test' or 'razorpay'");
  if (paymentProvider === "razorpay" && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)) {
    fail("RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when PAYMENT_PROVIDER=razorpay");
  }
  if (paymentProvider === "razorpay" && env.RAZORPAY_KEY_ID && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID)) {
    fail("RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…");
  }
  if (paymentProvider === "razorpay" && !isProduction && /^rzp_live_/.test(env.RAZORPAY_KEY_ID || "") && !bool(env.ALLOW_LIVE_PAYMENTS_OUTSIDE_PRODUCTION)) {
    fail("RAZORPAY_KEY_ID is a live key but NODE_ENV is not production (use Razorpay Test Mode keys locally)");
  }
  if (paymentProvider === "test" && isProduction && !bool(env.ALLOW_TEST_PAYMENTS)) {
    fail("PAYMENT_PROVIDER=test is not allowed in production (set PAYMENT_PROVIDER=razorpay)");
  }
  const placesProvider = env.PLACES_PROVIDER || (env.GOOGLE_MAPS_API_KEY ? "google" : isTest ? "fixture" : "none");
  if (!["google", "fixture", "none"].includes(placesProvider)) fail("PLACES_PROVIDER must be 'google', 'fixture' or 'none'");
  if (placesProvider === "google" && !env.GOOGLE_MAPS_API_KEY) fail("GOOGLE_MAPS_API_KEY is required when PLACES_PROVIDER=google");
  if (placesProvider === "fixture" && isProduction) fail("PLACES_PROVIDER=fixture is not allowed in production");
  const derived = (label) => require("crypto").createHmac("sha256", sessionSecret).update(label).digest("hex");

  const database = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST || "localhost",
        port: int("DB_PORT", 5434, { min: 1, max: 65535 }),
        user: env.DB_USER || "postgres",
        password: env.DB_PASSWORD || "admin",
        database: env.DB_NAME || "lost_found_db",
      };
  if (bool(env.DB_SSL)) {
    database.ssl = { rejectUnauthorized: bool(env.DB_SSL_REJECT_UNAUTHORIZED, true) };
  }
  database.max = int("DB_POOL_MAX", 10, { min: 1, max: 200 });

  const config = Object.freeze({
    nodeEnv,
    isProduction,
    isTest,
    port: int("PORT", 5000, { min: 1, max: 65535 }),
    appUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS).length ? list(env.ALLOWED_ORIGINS) : [appUrl],
    trustProxy: env.TRUST_PROXY === undefined ? 1 : int("TRUST_PROXY", 1),
    logLevel: env.LOG_LEVEL || (isTest ? "warn" : "info"),
    database,
    session: {
      secret: sessionSecret,
      cookieName: env.SESSION_COOKIE_NAME || "lf.sid",
      // Secure cookies whenever the public app is served over HTTPS.
      secureCookie: bool(env.COOKIE_SECURE, appIsHttps),
      maxAgeMs: int("SESSION_MAX_AGE_HOURS", 24 * 14) * 60 * 60 * 1000,
    },
    google: googleConfigured
      ? {
          clientID: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          callbackURL: env.GOOGLE_CALLBACK_URL || `${appUrl}/api/auth/google/callback`,
        }
      : null,
    apple: appleConfigured
      ? {
          clientID: env.APPLE_CLIENT_ID,
          teamID: env.APPLE_TEAM_ID,
          keyID: env.APPLE_KEY_ID,
          privateKeyString: env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          callbackURL: env.APPLE_CALLBACK_URL || `${appUrl}/api/auth/apple/callback`,
        }
      : null,
    emailLogin: bool(env.EMAIL_LOGIN_ENABLED, Boolean(env.RESEND_API_KEY || env.SMTP_URL) || isTest),
    mail: {
      // Resend (if RESEND_API_KEY is set) takes priority over SMTP.
      resendApiKey: env.RESEND_API_KEY || "",
      smtpUrl: env.SMTP_URL || "",
      from: env.EMAIL_FROM || env.MAIL_FROM || "Lost & Found <no-reply@localhost>",
      timeoutMs: int("EMAIL_TIMEOUT_MS", 10000),
      notificationEmails: bool(env.NOTIFICATION_EMAILS, Boolean(env.RESEND_API_KEY || env.SMTP_URL)),
    },
    otp: {
      ttlMinutes: int("OTP_TTL_MINUTES", 5),
      resendCooldownSeconds: int("OTP_RESEND_COOLDOWN_SECONDS", 60),
      maxAttempts: int("OTP_MAX_ATTEMPTS", 5),
      maxRequestsPerEmail: int("OTP_MAX_REQUESTS_PER_EMAIL", 5),
      requestWindowMinutes: int("OTP_REQUEST_WINDOW_MINUTES", 30),
    },
    storage: {
      driver: storageDriver,
      localDir: path.resolve(env.STORAGE_LOCAL_DIR || path.join(__dirname, "..", "..", "storage")),
      s3Bucket: env.S3_BUCKET || "",
      s3Region: env.S3_REGION || env.AWS_REGION || "us-east-1",
      s3Prefix: (env.S3_PREFIX || "").replace(/^\/|\/$/g, ""),
      cloudfrontDistributionId: env.CLOUDFRONT_DISTRIBUTION_ID || "",
      legacyUploadsDir: path.resolve(env.LEGACY_UPLOADS_DIR || path.join(__dirname, "..", "..", "uploads")),
    },
    uploads: {
      maxFiles: int("UPLOAD_MAX_FILES", 5),
      maxFileBytes: int("UPLOAD_MAX_FILE_MB", 8) * 1024 * 1024,
      maxPixels: int("UPLOAD_MAX_MEGAPIXELS", 40) * 1_000_000,
      maxDimension: int("UPLOAD_MAX_DIMENSION", 10000),
      minDimension: 32,
    },
    payments: {
      provider: paymentProvider,
      razorpay: {
        keyId: env.RAZORPAY_KEY_ID || "",
        keySecret: env.RAZORPAY_KEY_SECRET || "",
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
      },
      test: { keySecret: derived("test-payment-key"), webhookSecret: derived("test-payment-webhook") },
    },
    places: {
      provider: placesProvider,
      apiKey: env.GOOGLE_MAPS_API_KEY || "",
      timeoutMs: int("PLACES_TIMEOUT_MS", 4000),
      // Google permits caching place coordinates for up to 30 days; older
      // provider coordinates are refreshed by place ID or cleared.
      coordinateMaxAgeDays: int("PLACES_COORDINATE_MAX_AGE_DAYS", 30),
    },
    rateLimitMultiplier: Math.max(0.01, Number(env.RATE_LIMIT_MULTIPLIER || 1)),
    enableTestAuth,
    metricsEnabled: bool(env.METRICS_ENABLED, true),
  });
  if (problems.length) {
    const error = new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}\nSee docs/environment-variables.md.`);
    error.code = "invalid_config";
    error.problems = problems;
    throw error;
  }
  return config;
}

module.exports = { loadConfig };
