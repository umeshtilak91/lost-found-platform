-- Structured incident locations (additive; existing text locations are kept).
--
-- items.location            stays the human-readable label the reporter confirmed.
-- items.latitude/longitude  stay the private, precise coordinates (owner-only).
-- New metadata says where the location came from and how precise it is.
-- Public search and distances use only the ~1.1 km grid columns below, so
-- radius probing can never recover a reporter's precise position.

ALTER TABLE items ADD COLUMN IF NOT EXISTS location_source TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_provider TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_place_id TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_country CHAR(2);
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_admin_area TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_accuracy_m INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_coords_at TIMESTAMPTZ;

-- Legacy backfill: coordinates written before this migration came only from
-- the browser "use my location" button; everything else is free text.
UPDATE items SET location_source = CASE WHEN latitude IS NOT NULL THEN 'device' ELSE 'legacy' END,
                 location_coords_at = CASE WHEN latitude IS NOT NULL THEN COALESCE(updated_at, created_at) END
 WHERE location_source IS NULL;

ALTER TABLE items ALTER COLUMN location_source SET DEFAULT 'manual';
ALTER TABLE items ALTER COLUMN location_source SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_location_source_check
    CHECK (location_source IN ('provider', 'device', 'manual', 'legacy'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Provider results carry a place id (their coordinates may later be cleared
  -- when the provider's storage window lapses); device positions carry
  -- coordinates; manual and legacy text never claims coordinates.
  ALTER TABLE items ADD CONSTRAINT items_location_shape_check CHECK (
    (location_source = 'provider' AND location_place_id IS NOT NULL AND location_provider IS NOT NULL) OR
    (location_source = 'device' AND latitude IS NOT NULL AND location_place_id IS NULL) OR
    (location_source IN ('manual', 'legacy') AND latitude IS NULL AND location_place_id IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_location_country_check CHECK (location_country IS NULL OR location_country ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_location_accuracy_check CHECK (location_accuracy_m IS NULL OR location_accuracy_m BETWEEN 0 AND 1000000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Public grid (2 decimal places, about 1.1 km). Generated, so it can never drift.
ALTER TABLE items ADD COLUMN IF NOT EXISTS grid_lat DOUBLE PRECISION
  GENERATED ALWAYS AS (round(latitude::numeric, 2)::double precision) STORED;
ALTER TABLE items ADD COLUMN IF NOT EXISTS grid_lng DOUBLE PRECISION
  GENERATED ALWAYS AS (round(longitude::numeric, 2)::double precision) STORED;

CREATE INDEX IF NOT EXISTS items_grid_idx ON items (grid_lat, grid_lng)
  WHERE deleted_at IS NULL AND grid_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_provider_coords_idx ON items (location_coords_at)
  WHERE location_provider = 'google' AND latitude IS NOT NULL;
