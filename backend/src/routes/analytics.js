"use strict";

// Cookieless site-visitor analytics (see migrations/004_site_analytics.sql).
// - POST /api/analytics/pageview   records one page view (any visitor)
// - GET  /api/admin/analytics      aggregated stats (admins and moderators)
// Bots, Do-Not-Track and Global Privacy Control requests are not counted.

const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const { HttpError } = require("../middleware/errors");
const { requireModerator } = require("../middleware/security");

const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python-requests|axios|node-fetch/i;

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Normalises to a path with no query/fragment; listing and conversation IDs
// are kept for listings (useful "top listings") but conversations are private.
function normalisePath(raw) {
  let path = String(raw || "/").split(/[?#]/)[0];
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.startsWith("/api")) return null;
  path = path.replace(/\/+$/, "") || "/";
  path = path.replace(/^\/inbox\/\d+$/, "/inbox/:id").replace(/^\/items\/\d+\/edit$/, "/items/:id/edit");
  return path.slice(0, 200);
}

function referrerHost(raw, appUrl) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.origin === new URL(appUrl).origin) return null; // internal navigation
    return url.hostname.replace(/^www\./, "").slice(0, 100);
  } catch {
    return null;
  }
}

function analyticsRoutes({ pool, config }) {
  const router = express.Router();

  async function saltFor(day) {
    const fresh = crypto.randomBytes(32).toString("hex");
    const { rows } = await pool.query(
      `INSERT INTO analytics_salts (day, salt) VALUES ($1, $2)
       ON CONFLICT (day) DO UPDATE SET day = EXCLUDED.day RETURNING salt`,
      [day, fresh]
    );
    return rows[0].salt;
  }

  router.post("/analytics/pageview", async (req, res) => {
    const ua = req.get("user-agent") || "";
    if (!ua || BOT_UA.test(ua) || req.get("dnt") === "1" || req.get("sec-gpc") === "1") {
      return res.status(204).end();
    }
    const { path, referrer } = z
      .object({ path: z.string().max(500), referrer: z.string().max(1000).optional() })
      .strict()
      .parse(req.body || {});
    const cleanPath = normalisePath(path);
    if (!cleanPath) throw new HttpError(400, "Invalid path", "invalid_path");

    const day = utcDay();
    const salt = await saltFor(day);
    const visitorHash = crypto.createHash("sha256").update(`${salt}|${req.ip}|${ua}`).digest("hex");
    await pool.query(
      "INSERT INTO page_views (day, path, visitor_hash, referrer_host, signed_in) VALUES ($1, $2, $3, $4, $5)",
      [day, cleanPath, visitorHash, referrerHost(referrer, config.appUrl), Boolean(req.user)]
    );
    res.status(204).end();
  });

  router.get("/admin/analytics", requireModerator, async (req, res) => {
    const days = z.coerce.number().int().min(7).max(365).default(30).parse(req.query.days || undefined);
    const since = utcDay(new Date(Date.now() - (days - 1) * 86400000));
    const today = utcDay();
    const weekStart = utcDay(new Date(Date.now() - 6 * 86400000));

    const [daily, totals, pages, referrers] = await Promise.all([
      pool.query(
        `SELECT d::date AS day,
                COALESCE(count(DISTINCT pv.visitor_hash), 0)::int AS visitors,
                COALESCE(count(pv.id), 0)::int AS views
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN page_views pv ON pv.day = d::date
         GROUP BY d ORDER BY d`,
        [since, today]
      ),
      // Visitor hashes rotate daily, so multi-day "visitors" is the sum of
      // daily unique visitors (the same person on two days counts twice).
      pool.query(
        `WITH per_day AS (
           SELECT day, count(DISTINCT visitor_hash)::int AS visitors, count(*)::int AS views
           FROM page_views WHERE day >= $1 GROUP BY day)
         SELECT
           COALESCE(sum(visitors) FILTER (WHERE day = $2), 0)::int AS visitors_today,
           COALESCE(sum(views) FILTER (WHERE day = $2), 0)::int AS views_today,
           COALESCE(sum(visitors) FILTER (WHERE day >= $3), 0)::int AS visitors_7d,
           COALESCE(sum(views) FILTER (WHERE day >= $3), 0)::int AS views_7d,
           COALESCE(sum(visitors), 0)::int AS visitors_period,
           COALESCE(sum(views), 0)::int AS views_period
         FROM per_day`,
        [since, today, weekStart]
      ),
      pool.query(
        `SELECT path, count(*)::int AS views, count(DISTINCT (day, visitor_hash))::int AS visitors
         FROM page_views WHERE day >= $1 GROUP BY path ORDER BY views DESC, path LIMIT 10`,
        [since]
      ),
      pool.query(
        `SELECT referrer_host AS host, count(DISTINCT (day, visitor_hash))::int AS visitors
         FROM page_views WHERE day >= $1 AND referrer_host IS NOT NULL
         GROUP BY referrer_host ORDER BY visitors DESC, host LIMIT 10`,
        [since]
      ),
    ]);

    res.set("Cache-Control", "private, no-store").json({
      days,
      totals: {
        visitorsToday: totals.rows[0].visitors_today,
        viewsToday: totals.rows[0].views_today,
        visitors7d: totals.rows[0].visitors_7d,
        views7d: totals.rows[0].views_7d,
        visitorsPeriod: totals.rows[0].visitors_period,
        viewsPeriod: totals.rows[0].views_period,
      },
      daily: daily.rows.map((row) => ({ day: row.day, visitors: row.visitors, views: row.views })),
      topPages: pages.rows,
      topReferrers: referrers.rows,
    });
  });

  return router;
}

module.exports = { analyticsRoutes, normalisePath, referrerHost };
