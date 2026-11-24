"use strict";

const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const pinoHttp = require("pino-http");
const client = require("prom-client");

const { pendingMigrations } = require("./migrate");
const { createStorage } = require("./integrations/storage");
const { createMailer } = require("./integrations/mailer");
const { createNotifier } = require("./services/notifications");
const { createOtpService } = require("./auth/otp");
const { configurePassport } = require("./auth/passport");
const { csrfProtection, createRateLimiters } = require("./middleware/security");
const { errorHandler, notFound } = require("./middleware/errors");
const { authRoutes } = require("./routes/auth");
const { itemRoutes } = require("./routes/items");
const { claimRoutes } = require("./routes/claims");
const { conversationRoutes } = require("./routes/conversations");
const { notificationRoutes } = require("./routes/notifications");
const { moderationRoutes } = require("./routes/moderation");
const { accountRoutes } = require("./routes/account");
const { mediaRoutes } = require("./routes/media");
const { analyticsRoutes } = require("./routes/analytics");
const { paymentRoutes, paymentWebhookRoutes } = require("./routes/payments");
const { createPaymentProvider } = require("./integrations/payments");
const { createConnectionService } = require("./services/connections");
const { publicPricing } = require("./config/pricing");
const { createPlacesProvider } = require("./integrations/places");
const { placesRoutes } = require("./routes/places");
const { createReturnService } = require("./services/returns");

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

function createApp({
  config,
  pool,
  logger,
  storage = createStorage(config.storage, logger),
  mailer = createMailer(config, logger),
  places = createPlacesProvider(config),
}) {
  const app = express();
  app.disable("x-powered-by");
  app.locals.pool = pool;
  app.locals.places = places;
  app.set("trust proxy", config.trustProxy);

  // --- Request IDs + structured access logs (no bodies, redacted headers) ---
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => ["/healthz", "/readyz", "/metrics"].includes(req.url) },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split("?")[0], remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customProps: (req) => ({ userId: req.user?.id }),
    })
  );

  // --- Metrics ---------------------------------------------------------------
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${Array.isArray(req.route.path) ? req.route.path[0] : req.route.path}` : "unmatched";
      end({ method: req.method, route, status: res.statusCode });
    });
    next();
  });

  // --- Probes (before sessions so they never touch the session store) -------
  app.get("/healthz", (req, res) => res.json({ status: "ok" }));
  app.get("/readyz", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      const pending = await pendingMigrations(pool);
      if (pending.length) return res.status(503).json({ status: "migrations_pending", pending });
      await storage.healthy();
      return res.json({ status: "ready" });
    } catch (error) {
      req.log.warn({ err: { message: error.message } }, "Readiness check failed");
      return res.status(503).json({ status: "unavailable" });
    }
  });
  if (config.metricsEnabled) {
    app.get("/metrics", async (req, res) => {
      res.set("Content-Type", registry.contentType).send(await registry.metrics());
    });
  }

  // --- Security headers -----------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
      hsts: config.session.secureCookie ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );
  // Only needed when the API is called cross-origin (the web app normally
  // proxies /api through its own origin). Origins are an explicit allow-list.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.allowedOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Request-Id"],
      methods: ["GET", "POST", "PATCH", "DELETE"],
    })
  );

  // --- Sessions in PostgreSQL -----------------------------------------------
  app.use(
    session({
      name: config.session.cookieName,
      store: new PgSession({ pool, tableName: "session", createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
      secret: config.session.secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.session.secureCookie,
        maxAge: config.session.maxAgeMs,
        path: "/",
      },
    })
  );

  const passport = configurePassport({ pool, config, logger });
  app.use(passport.initialize());
  app.use(passport.session());

  // Payment provider + paid-connection service. The webhook is mounted before
  // the JSON parser because signature validation needs the raw body bytes.
  const provider = createPaymentProvider(config, pool);
  const notifier = createNotifier({ pool, mailer, config, logger });
  const connections = createConnectionService({ pool, provider, notifier, logger });
  app.use("/api", paymentWebhookRoutes({ connections, provider }));

  app.use(express.json({ limit: "64kb" }));

  const limits = createRateLimiters(pool, config);
  app.use("/api", limits.general);
  // Apple's form_post callback is a cross-site POST and is protected by the
  // OAuth state parameter instead.
  app.use("/api", csrfProtection(config, { exempt: ["/auth/apple/callback", "/payments/webhook"] }));

  const otp = createOtpService({ pool, mailer, config });
  const returns = createReturnService({ pool, notifier, logger });
  app.locals.returns = returns;
  const deps = { pool, config, storage, notifier, limits, logger, passport, otp, connections, provider, places, returns };

  app.get("/", (req, res) => res.json({ service: "lost-found-api" }));
  app.use("/api/auth", authRoutes(deps));
  app.use("/api", itemRoutes(deps));
  app.use("/api", claimRoutes(deps));
  app.use("/api", conversationRoutes(deps));
  app.use("/api", notificationRoutes(deps));
  app.use("/api", moderationRoutes(deps));
  app.use("/api", accountRoutes(deps));
  app.use("/api", mediaRoutes(deps));
  app.use("/api", analyticsRoutes(deps));
  app.use("/api", paymentRoutes(deps));
  app.use("/api", placesRoutes(deps));
  app.get("/api/pricing", (req, res) => res.set("Cache-Control", "public, max-age=300").json(publicPricing()));
  app.use(mediaRoutes(deps)); // also blocks legacy /uploads/* at the root

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
