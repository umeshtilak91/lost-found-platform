-- Core platform schema: identities, listing lifecycle, images, private contact,
-- claims, notifications, moderation, one-time codes, sessions and rate limits.
-- Every statement is additive or guarded so it runs on clean installs and on
-- databases created by the original prototype (which may already hold data).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- Prototype timestamps were written by CURRENT_TIMESTAMP in the server's
-- TimeZone without zone info; convert them to unambiguous timestamptz.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at') = 'timestamp without time zone' THEN
    ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE current_setting('TimeZone');
  END IF;
END $$;
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_phone_contact BOOLEAN DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN mobile_number TYPE VARCHAR(20);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'moderator', 'admin'));
  END IF;
END $$;

-- Prototype stored Indian numbers without a country code; normalise to E.164.
UPDATE users SET mobile_number = '+91' || mobile_number WHERE mobile_number ~ '^[6-9][0-9]{9}$';
UPDATE users SET mobile_number = '+' || mobile_number WHERE mobile_number ~ '^91[6-9][0-9]{9}$';

-- Google-authenticated prototype accounts have provider-verified email addresses.
UPDATE users SET email_verified = TRUE WHERE google_id IS NOT NULL AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS auth_identities (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'email', 'test')),
    subject     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id);

INSERT INTO auth_identities (user_id, provider, subject)
SELECT id, 'google', google_id FROM users WHERE google_id IS NOT NULL
ON CONFLICT (provider, subject) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE items ADD COLUMN IF NOT EXISTS moderation_state TEXT NOT NULL DEFAULT 'visible';
ALTER TABLE items ADD COLUMN IF NOT EXISTS ownership_question TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE items ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

UPDATE items SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'created_at') = 'timestamp without time zone' THEN
    ALTER TABLE items ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE current_setting('TimeZone');
  END IF;
END $$;
ALTER TABLE items ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE items ALTER COLUMN created_at SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_category_check') THEN
    ALTER TABLE items ADD CONSTRAINT items_category_check CHECK (category IN
      ('phone', 'electronics', 'wallet', 'bag', 'keys', 'documents', 'jewelry', 'clothing', 'pet', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_status_check') THEN
    ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN ('open', 'claimed', 'returned', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_moderation_state_check') THEN
    ALTER TABLE items ADD CONSTRAINT items_moderation_state_check CHECK (moderation_state IN ('visible', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_coordinates_check') THEN
    ALTER TABLE items ADD CONSTRAINT items_coordinates_check CHECK (
      (latitude IS NULL AND longitude IS NULL) OR
      (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180));
  END IF;
END $$;

-- Listing/search queries: type + visibility + status, newest first with id tiebreak.
CREATE INDEX IF NOT EXISTS items_browse_idx
    ON items (type, status, created_at DESC, id DESC)
    WHERE deleted_at IS NULL AND moderation_state = 'visible';
CREATE INDEX IF NOT EXISTS items_event_date_idx ON items (date)
    WHERE deleted_at IS NULL AND moderation_state = 'visible';
CREATE INDEX IF NOT EXISTS items_category_idx ON items (category, created_at DESC)
    WHERE deleted_at IS NULL AND moderation_state = 'visible';
CREATE INDEX IF NOT EXISTS items_user_idx ON items (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS items_name_trgm_idx ON items USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_location_trgm_idx ON items USING gin (location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_description_trgm_idx ON items USING gin (description gin_trgm_ops);

CREATE TABLE IF NOT EXISTS item_images (
    id           BIGSERIAL PRIMARY KEY,
    item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    storage_key  TEXT NOT NULL UNIQUE,
    thumb_key    TEXT NOT NULL UNIQUE,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    legacy_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_images_item_idx ON item_images (item_id, position, id);

-- ---------------------------------------------------------------------------
-- Private contact
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id                        BIGSERIAL PRIMARY KEY,
    item_id                   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    reporter_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reporter_shares_phone     BOOLEAN NOT NULL DEFAULT FALSE,
    participant_shares_phone  BOOLEAN NOT NULL DEFAULT FALSE,
    reporter_last_read_at     TIMESTAMPTZ,
    participant_last_read_at  TIMESTAMPTZ,
    last_message_at           TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, participant_id),
    CHECK (reporter_id <> participant_id)
);
CREATE INDEX IF NOT EXISTS conversations_reporter_idx ON conversations (reporter_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS conversations_participant_idx ON conversations (participant_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS messages (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body             TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    client_id        UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Ownership claims
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
    id            BIGSERIAL PRIMARY KEY,
    item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    claimant_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answer        TEXT NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 1000),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'revoked', 'superseded')),
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_pending_per_claimant
    ON claims (item_id, claimant_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_accepted_per_item
    ON claims (item_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS claims_claimant_idx ON claims (claimant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('match', 'message', 'claim_received', 'claim_update',
                                              'item_status', 'listing_removed', 'listing_restored')),
    item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key  TEXT NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id               BIGSERIAL PRIMARY KEY,
    notification_id  BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
    detail           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (notification_id, channel)
);

-- ---------------------------------------------------------------------------
-- Abuse reports and moderation audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_reports (
    id           BIGSERIAL PRIMARY KEY,
    item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason       TEXT NOT NULL CHECK (reason IN ('spam', 'scam', 'inappropriate', 'personal_info', 'duplicate', 'other')),
    details      TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
    resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS listing_reports_one_open_per_reporter
    ON listing_reports (item_id, reporter_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS listing_reports_queue_idx ON listing_reports (status, created_at);

CREATE TABLE IF NOT EXISTS moderation_actions (
    id            BIGSERIAL PRIMARY KEY,
    moderator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
    report_id     BIGINT REFERENCES listing_reports(id) ON DELETE SET NULL,
    action        TEXT NOT NULL CHECK (action IN ('remove_listing', 'restore_listing', 'dismiss_report')),
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_item_idx ON moderation_actions (item_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Email one-time codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_codes (
    id           BIGSERIAL PRIMARY KEY,
    email        TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_email_idx ON otp_codes (email, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shared session store (connect-pg-simple layout) and rate-limit counters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
    "sid"    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
    "sess"   JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS rate_limits (
    key       TEXT PRIMARY KEY,
    hits      INTEGER NOT NULL,
    reset_at  TIMESTAMPTZ NOT NULL
);
