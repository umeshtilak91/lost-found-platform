-- Base schema for installs that never had the hand-created tables.
-- Idempotent so it is safe on databases created by the original prototype.
CREATE TABLE IF NOT EXISTS users (
    id                  SERIAL PRIMARY KEY,
    google_id           VARCHAR(255) UNIQUE,
    name                VARCHAR(255),
    email               VARCHAR(255),
    profile_image       TEXT,
    mobile_number       VARCHAR(20),
    allow_phone_contact BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    location    VARCHAR(255) NOT NULL,
    date        DATE NOT NULL,
    description TEXT,
    image       VARCHAR(255),
    type        VARCHAR(10) NOT NULL,
    user_id     INTEGER REFERENCES users(id),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
