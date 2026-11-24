-- Item-return lifecycle (additive; existing records are classified, not rewritten).
--
-- Business states map onto the existing columns:
--   OPEN                         items.status = 'open'
--   RETURN BEING ARRANGED        items.status = 'claimed' (accepted match), claims.handover_at IS NULL
--   AWAITING OWNER CONFIRMATION  items.status = 'claimed', claims.handover_at IS NOT NULL, return_confirmed_at IS NULL
--   RETURNED                     items.status = 'returned', claims.return_confirmed_at IS NOT NULL
--   closed variants              items.status = 'closed' + items.closure_reason
--
-- A recovery is counted once in `recoveries`, even when a lost listing and a
-- found listing describe the same return. Corrections keep the row and mark
-- it corrected, so history and statistics stay consistent.

-- ---------------------------------------------------------------------------
-- Recoveries (one row per completed return; corrected rows are kept)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recoveries (
    id                 BIGSERIAL PRIMARY KEY,
    kind               TEXT NOT NULL CHECK (kind IN ('matched', 'self_recovered', 'external', 'legacy')),
    claim_id           BIGINT REFERENCES claims(id) ON DELETE SET NULL,
    lost_item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
    found_item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
    owner_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    finder_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    completed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    corrected_at       TIMESTAMPTZ,
    corrected_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    correction_reason  TEXT CHECK (correction_reason IS NULL OR char_length(correction_reason) <= 1000),
    CHECK (lost_item_id IS NOT NULL OR found_item_id IS NOT NULL),
    CHECK (corrected_at IS NOT NULL OR correction_reason IS NULL)
);
-- At most one live recovery per match and per listing: retries, both linked
-- listings closing, and concurrent confirmations cannot double-count.
CREATE UNIQUE INDEX IF NOT EXISTS recoveries_live_claim ON recoveries (claim_id) WHERE corrected_at IS NULL AND claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recoveries_live_lost ON recoveries (lost_item_id) WHERE corrected_at IS NULL AND lost_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recoveries_live_found ON recoveries (found_item_id) WHERE corrected_at IS NULL AND found_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recoveries_owner_idx ON recoveries (owner_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS recoveries_finder_idx ON recoveries (finder_id, completed_at DESC);

-- ---------------------------------------------------------------------------
-- Listings and matches
-- ---------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS closure_reason TEXT;
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_closure_reason_check CHECK (closure_reason IS NULL OR closure_reason IN
    ('returned_matched', 'self_recovered', 'returned_external', 'closed_by_reporter', 'legacy_returned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE items ADD COLUMN IF NOT EXISTS recovery_id BIGINT REFERENCES recoveries(id) ON DELETE SET NULL;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS handover_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS handover_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- The claimant's own listing of the opposite type describing the same item.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS linked_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL;
-- Why a claim was closed by the system (shown to the claimant).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS close_reason TEXT;
CREATE INDEX IF NOT EXISTS claims_linked_item_idx ON claims (linked_item_id) WHERE linked_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_handover_pending_idx ON claims (handover_at)
  WHERE status = 'accepted' AND handover_at IS NOT NULL AND return_confirmed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only audit trail of return events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS return_events (
    id           BIGSERIAL PRIMARY KEY,
    event        TEXT NOT NULL CHECK (event IN (
                   'handover_reported', 'receipt_confirmed', 'return_completed', 'problem_reported',
                   'self_recovered', 'external_return', 'match_cancelled', 'correction_requested',
                   'correction_applied', 'correction_rejected', 'reward_confirmed', 'reward_issue', 'reminder_sent',
                   'legacy_backfill')),
    claim_id     BIGINT REFERENCES claims(id) ON DELETE SET NULL,
    item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
    recovery_id  BIGINT REFERENCES recoveries(id) ON DELETE SET NULL,
    actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note         TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_events_claim_idx ON return_events (claim_id, created_at);
CREATE INDEX IF NOT EXISTS return_events_item_idx ON return_events (item_id, created_at);

-- ---------------------------------------------------------------------------
-- Support: return problems and correction requests
-- ---------------------------------------------------------------------------
ALTER TABLE support_requests DROP CONSTRAINT IF EXISTS support_requests_kind_check;
ALTER TABLE support_requests ADD CONSTRAINT support_requests_kind_check CHECK (kind IN ('refund', 'reward_issue', 'return_issue', 'return_correction'));
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id) ON DELETE SET NULL;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS recovery_id BIGINT REFERENCES recoveries(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS support_one_open_return_issue ON support_requests (claim_id, requester_id) WHERE kind = 'return_issue' AND status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS support_one_open_correction ON support_requests (recovery_id) WHERE kind = 'return_correction' AND status = 'open';

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'match', 'message', 'claim_received', 'claim_update', 'item_status', 'listing_removed', 'listing_restored',
  'payment_due', 'connection_unlocked', 'return_confirmed', 'reward_update', 'support_update',
  'handover_reported', 'return_reminder', 'return_corrected'));

-- ---------------------------------------------------------------------------
-- Legacy classification (runs once; guarded by recovery_id / closure_reason)
-- ---------------------------------------------------------------------------
-- Owner-confirmed returns from the existing flow: one matched recovery each.
WITH confirmed AS (
  SELECT DISTINCT ON (i.id) i.id AS item_id, i.type, c.id AS claim_id, c.owner_id, c.finder_id, c.return_confirmed_at, c.return_confirmed_by
  FROM items i JOIN claims c ON c.item_id = i.id AND c.status = 'accepted' AND c.return_confirmed_at IS NOT NULL
  WHERE i.status = 'returned' AND i.recovery_id IS NULL
  ORDER BY i.id, c.return_confirmed_at
), ins AS (
  INSERT INTO recoveries (kind, claim_id, lost_item_id, found_item_id, owner_id, finder_id, completed_at, completed_by)
  SELECT 'matched', claim_id, CASE WHEN type = 'lost' THEN item_id END, CASE WHEN type = 'found' THEN item_id END,
         owner_id, finder_id, return_confirmed_at, return_confirmed_by FROM confirmed
  RETURNING id, COALESCE(lost_item_id, found_item_id) AS item_id
)
UPDATE items i SET recovery_id = ins.id, closure_reason = 'returned_matched' FROM ins WHERE i.id = ins.item_id;

-- Listings marked "returned" without an owner confirmation (the poster used
-- the old status button): kept as returned, counted separately as legacy.
WITH legacy AS (
  SELECT id, type, user_id, COALESCE(status_changed_at, updated_at, created_at::timestamptz) AS at
  FROM items WHERE status = 'returned' AND recovery_id IS NULL
), ins AS (
  INSERT INTO recoveries (kind, lost_item_id, found_item_id, owner_id, finder_id, completed_at)
  SELECT 'legacy', CASE WHEN type = 'lost' THEN id END, CASE WHEN type = 'found' THEN id END,
         CASE WHEN type = 'lost' THEN user_id END, CASE WHEN type = 'found' THEN user_id END, at FROM legacy
  RETURNING id, COALESCE(lost_item_id, found_item_id) AS item_id
)
UPDATE items i SET recovery_id = ins.id, closure_reason = 'legacy_returned' FROM ins WHERE i.id = ins.item_id;

UPDATE items SET closure_reason = 'closed_by_reporter' WHERE status = 'closed' AND closure_reason IS NULL;

INSERT INTO return_events (event, item_id, recovery_id, note)
SELECT 'legacy_backfill', COALESCE(r.lost_item_id, r.found_item_id), r.id, r.kind FROM recoveries r
WHERE NOT EXISTS (SELECT 1 FROM return_events e WHERE e.recovery_id = r.id AND e.event = 'legacy_backfill');
