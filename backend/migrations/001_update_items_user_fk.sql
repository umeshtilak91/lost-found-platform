BEGIN;

-- Remove the existing foreign key constraint
ALTER TABLE items
DROP CONSTRAINT IF EXISTS items_user_id_fkey;

-- Recreate the foreign key with desired rules
ALTER TABLE items
ADD CONSTRAINT items_user_id_fkey
FOREIGN KEY (user_id)
REFERENCES users(id)
ON DELETE SET NULL
ON UPDATE CASCADE;

COMMIT;