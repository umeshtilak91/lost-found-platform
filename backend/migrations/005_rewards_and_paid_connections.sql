-- Category finder rewards + ₹100 paid connection.
-- Amounts are integer paise. The platform only ever charges the connection
-- fee; finder rewards are paid directly between users and only recorded.

-- ---------------------------------------------------------------------------
-- Listings: owner reward acknowledgement (lost listings) + category confirmation
-- ---------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_confirmed BOOLEAN NOT NULL DEFAULT TRUE;
-- Prototype rows received category 'other' by default in 003, so an existing
-- 'other' may not be a real choice: the poster confirms it before a new paid
-- connection starts. (Runs once; new rows default to confirmed.)
UPDATE items SET category_confirmed = FALSE WHERE category = 'other';
ALTER TABLE items ADD COLUMN IF NOT EXISTS reward_paise INTEGER CHECK (reward_paise IS NULL OR reward_paise > 0);
ALTER TABLE items ADD COLUMN IF NOT EXISTS reward_pricing_version TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reward_terms_version TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reward_accepted_at TIMESTAMPTZ;

-- Listings flagged for possible contact details wait for moderator review.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_moderation_state_check;
ALTER TABLE items ADD CONSTRAINT items_moderation_state_check CHECK (moderation_state IN ('visible', 'removed', 'pending'));

-- ---------------------------------------------------------------------------
-- Claims become explicit owner/finder matches with an immutable reward snapshot
-- ---------------------------------------------------------------------------
ALTER TABLE claims ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS finder_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
UPDATE claims c SET
  owner_id  = CASE WHEN i.type = 'found' THEN c.claimant_id ELSE i.user_id END,
  finder_id = CASE WHEN i.type = 'found' THEN i.user_id ELSE c.claimant_id END
FROM items i WHERE i.id = c.item_id AND c.owner_id IS NULL;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS agreement_category TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS reward_paise INTEGER CHECK (reward_paise IS NULL OR reward_paise > 0);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS fee_paise INTEGER CHECK (fee_paise IS NULL OR fee_paise > 0);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS currency TEXT CHECK (currency IS NULL OR currency = 'INR');
ALTER TABLE claims ADD COLUMN IF NOT EXISTS pricing_version TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS owner_accepted_at TIMESTAMPTZ;

-- Snapshot columns are write-once: once accepted they cannot be edited.
CREATE OR REPLACE FUNCTION claims_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.owner_accepted_at IS NOT NULL AND OLD.status = 'accepted' AND (
       NEW.reward_paise IS DISTINCT FROM OLD.reward_paise OR
       NEW.fee_paise IS DISTINCT FROM OLD.fee_paise OR
       NEW.agreement_category IS DISTINCT FROM OLD.agreement_category OR
       NEW.pricing_version IS DISTINCT FROM OLD.pricing_version OR
       NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
       NEW.owner_accepted_at IS DISTINCT FROM OLD.owner_accepted_at) THEN
    RAISE EXCEPTION 'accepted reward agreement is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS claims_snapshot_immutable ON claims;
CREATE TRIGGER claims_snapshot_immutable BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION claims_snapshot_immutable();

-- Return confirmation (owner) and external reward receipt (finder) are separate facts.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS return_confirmed_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS return_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS reward_status TEXT NOT NULL DEFAULT 'awaiting'
  CHECK (reward_status IN ('awaiting', 'confirmed', 'issue'));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS reward_status_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS reward_status_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS reward_issue_note TEXT CHECK (reward_issue_note IS NULL OR char_length(reward_issue_note) <= 1000);

-- ---------------------------------------------------------------------------
-- Connection payments (always 10000 paise INR under pricing v1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connection_payments (
    id                   BIGSERIAL PRIMARY KEY,
    -- Kept (claim link nulled) if a match/account is deleted: payment records are retained for accounting.
    claim_id             BIGINT REFERENCES claims(id) ON DELETE SET NULL,
    owner_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    provider             TEXT NOT NULL CHECK (provider IN ('razorpay', 'test')),
    provider_order_id    TEXT NOT NULL UNIQUE,
    provider_payment_id  TEXT UNIQUE,
    amount_paise         INTEGER NOT NULL CHECK (amount_paise > 0),
    currency             TEXT NOT NULL CHECK (currency = 'INR'),
    status               TEXT NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded')),
    failure_reason       TEXT,
    provider_refund_id   TEXT,
    paid_at              TIMESTAMPTZ,
    refunded_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one open order and one successful payment per match.
CREATE UNIQUE INDEX IF NOT EXISTS connection_payments_one_open
    ON connection_payments (claim_id) WHERE status IN ('created', 'pending');
CREATE UNIQUE INDEX IF NOT EXISTS connection_payments_one_paid
    ON connection_payments (claim_id) WHERE status IN ('paid', 'refund_pending');
CREATE INDEX IF NOT EXISTS connection_payments_claim_idx ON connection_payments (claim_id, created_at DESC);

-- Provider webhook/event deduplication.
CREATE TABLE IF NOT EXISTS payment_events (
    provider     TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    order_id     TEXT,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_id)
);

-- Local test-mode provider ledger (only used when PAYMENT_PROVIDER=test).
CREATE TABLE IF NOT EXISTS test_provider_payments (
    payment_id   TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    currency     TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Communication access: conversations start locked; payment unlocks the one
-- conversation that belongs to the paid match.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unlock_source TEXT CHECK (unlock_source IS NULL OR unlock_source IN ('grandfathered', 'payment'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unlock_claim_id BIGINT REFERENCES claims(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS locked_reason TEXT;

-- Grandfathering: conversations that existed before paid connections keep
-- their access. Only conversations created from now on start locked.
UPDATE conversations SET unlocked_at = now(), unlock_source = 'grandfathered'
WHERE unlocked_at IS NULL AND unlock_source IS NULL AND locked_reason IS NULL;

CREATE TABLE IF NOT EXISTS connection_entitlements (
    id               BIGSERIAL PRIMARY KEY,
    claim_id         BIGINT NOT NULL UNIQUE REFERENCES claims(id) ON DELETE CASCADE,
    conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    payment_id       BIGINT NOT NULL REFERENCES connection_payments(id) ON DELETE CASCADE,
    granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at       TIMESTAMPTZ,
    revoke_reason    TEXT
);

-- ---------------------------------------------------------------------------
-- Support: connection-fee refund requests and reward payment issues
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_requests (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('refund', 'reward_issue')),
    claim_id      BIGINT REFERENCES claims(id) ON DELETE CASCADE,
    payment_id    BIGINT REFERENCES connection_payments(id) ON DELETE SET NULL,
    requester_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message       TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'resolved')),
    resolution    TEXT,
    resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS support_one_open_refund ON support_requests (payment_id) WHERE kind = 'refund' AND status = 'open';
CREATE INDEX IF NOT EXISTS support_queue_idx ON support_requests (status, created_at);

-- New notification types.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'match', 'message', 'claim_received', 'claim_update', 'item_status', 'listing_removed', 'listing_restored',
  'payment_due', 'connection_unlocked', 'return_confirmed', 'reward_update', 'support_update'));
