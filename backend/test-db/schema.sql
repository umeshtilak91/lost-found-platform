
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    google_id VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    email VARCHAR NOT NULL UNIQUE,
    profile_image TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mobile_number VARCHAR,
    allow_phone_contact BOOLEAN DEFAULT FALSE
);

CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL,
    location VARCHAR NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    created_at TIMESTAMP,
    image VARCHAR,
    type VARCHAR NOT NULL,
    user_id INTEGER,
    CONSTRAINT items_type_check
        CHECK (type IN ('lost', 'found')),
    CONSTRAINT items_user_id_fkey
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
);

CREATE INDEX idx_items_created_at ON items(created_at);
CREATE INDEX idx_items_type ON items(type);
CREATE INDEX idx_items_user_id ON items(user_id);
