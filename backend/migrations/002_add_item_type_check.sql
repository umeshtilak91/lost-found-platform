BEGIN;

-- Add item type validation only if it does not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'items_type_check'
    ) THEN
        ALTER TABLE items
        ADD CONSTRAINT items_type_check
        CHECK (type IN ('lost', 'found'));
    END IF;
END $$;

COMMIT;