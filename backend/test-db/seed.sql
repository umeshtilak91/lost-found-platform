INSERT INTO users (
    id,
    google_id,
    name,
    email
)
VALUES (
    1,
    'ci-test-google-id',
    'CI Test User',
    'ci-test@example.com'
);

INSERT INTO items (
    id,
    name,
    location,
    date,
    description,
    type,
    user_id
)
VALUES (
    16,
    'Test Wallet',
    'Pune',
    '2026-10-10',
    'CI test item',
    'lost',
    1
);

-- Keep the sequences ready for future inserts.
SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));
SELECT setval('items_id_seq', (SELECT MAX(id) FROM items));
