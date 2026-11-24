-- First-party, cookieless visitor analytics.
-- A visitor is identified only within one UTC day by
--   sha256(daily_salt || ip || user_agent)
-- where daily_salt is random and deleted after two days, so hashes cannot be
-- linked across days or reversed to an IP address. No raw IPs are stored.

CREATE TABLE IF NOT EXISTS analytics_salts (
    day   DATE PRIMARY KEY,
    salt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_views (
    id             BIGSERIAL PRIMARY KEY,
    day            DATE NOT NULL,
    path           TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 200),
    visitor_hash   TEXT NOT NULL,
    referrer_host  TEXT CHECK (referrer_host IS NULL OR char_length(referrer_host) <= 100),
    signed_in      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_views_day_idx ON page_views (day, visitor_hash);
CREATE INDEX IF NOT EXISTS page_views_day_path_idx ON page_views (day, path);
