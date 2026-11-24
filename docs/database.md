# Database

PostgreSQL 16 (extensions: `pg_trgm` for text search). Schema is defined only
by the SQL files in `backend/migrations/`, applied in file-name order and
recorded (with checksums) in `schema_migrations`.

## Models and relationships

```mermaid
erDiagram
  users ||--o{ auth_identities : "signs in with"
  users ||--o{ items : posts
  items ||--o{ item_images : has
  items ||--o{ claims : receives
  users ||--o{ claims : "claims as claimant"
  claims ||--o{ connection_payments : "₹100 fee"
  connection_payments ||--o{ connection_entitlements : grants
  claims ||--o| conversations : unlocks
  items ||--o{ conversations : about
  conversations ||--o{ messages : contains
  claims ||--o| recoveries : "completes as"
  items ||--o{ return_events : "audit log"
  users ||--o{ notifications : receives
  notifications ||--o{ notification_deliveries : "email attempts"
  items ||--o{ listing_reports : "abuse reports"
  listing_reports ||--o{ moderation_actions : "acted on"
  claims ||--o{ support_requests : "refunds, issues, corrections"
```

| Table | Purpose | Migration |
|---|---|---|
| `users` | Account, role (`user`/`moderator`/`admin`), locale, optional phone | 000, 003 |
| `auth_identities` | Google/Apple/email subjects linked to a user | 003 |
| `session` | Express sessions (`connect-pg-simple`) | 003 |
| `items` | Lost/found listings: status (`open`, `claimed`, `returned`, `closed`), moderation state, reward acknowledgement, location columns, closure reason | 000, 003, 005, 007, 008 |
| `item_images` | Stored WebP images (keys only) | 003 |
| `claims` | Matches: private answer, decisions, immutable reward snapshot (`reward_paise`, `fee_paise`, versions), unlock, handover and receipt times, reward status | 003, 005, 008 |
| `connection_payments`, `payment_events`, `connection_entitlements`, `test_provider_payments` | ₹100 orders, deduplicated provider events, what a payment unlocked, fake-provider state | 005 |
| `conversations`, `messages` | Chat per match | 003 |
| `recoveries` | One row per completed recovery (`matched`, `self_recovered`, `external`, `legacy`); partial unique indexes allow one live row per match / lost listing / found listing | 008 |
| `return_events` | Append-only audit of the return lifecycle | 008 |
| `support_requests` | Refund requests, return issues, correction requests | 005, 008 |
| `notifications`, `notification_deliveries` | In-app notifications (deduplicated by key) and email delivery attempts | 003 |
| `listing_reports`, `moderation_actions` | Abuse reports and the moderator audit log | 003 |
| `otp_codes` | Email sign-in challenges (HMAC of the code only, never the code) | 006 |
| `rate_limits` | Shared rate-limit counters | 003 |
| `page_views`, `analytics_salts` | Cookie-less analytics with daily-rotating salts | 004 |

Integrity rules worth knowing:
- A trigger rejects changes to an accepted reward snapshot.
- Location shape and country codes are checked by constraints.
- `grid_lat`/`grid_lng` are generated columns (0.01° grid) for public distance search.

## Migration commands

| Situation | Command |
|---|---|
| Local compose | Automatic: the one-off `migrate` service runs `node server.js migrate` before the API starts. Manually: `docker compose run --rm migrate` |
| Local API outside Docker | `cd backend && npm run migrate` |
| Kubernetes | Helm `pre-install,pre-upgrade` Job runs `node server.js migrate` before pods change ([deployment.md](deployment.md#migration-order)) |

The runner takes a PostgreSQL advisory lock, applies each pending file in its
own transaction and warns if an applied file's checksum changed. `/readyz`
returns 503 while migrations are pending. Every migration is additive and
safe to re-run; `backend/test/migrations.test.js` covers upgrading the
original prototype schema.

## Test data

- **Integration tests** (`backend/test/helpers.js`) create a fresh, uniquely
  named database per test file on the server in `TEST_DATABASE_URL`
  (default `postgres://postgres:test@localhost:5544/postgres`) and drop it
  afterwards. Users are created through the test login with
  `@example.com`-style addresses.
- **Browser tests** run against the isolated `lftest` compose project with its
  own volume; `npm run e2e:down` deletes everything (`down -v`).
- There is **no seed script for real environments** and no fixture contains
  real personal data. To try the app locally, sign in with any address and
  read the code in Mailpit (http://localhost:8025).

## Backup and restore

Local compose (database volume `lost-found-platform_pgdata`, images in `lost-found-platform_storage`):

```bash
# Backup
docker compose exec -T db pg_dump -U postgres -Fc lost_found_db > backup-$(date +%F).dump
# Restore into a fresh database
docker compose exec -T db createdb -U postgres lost_found_restore
docker compose exec -T db pg_restore -U postgres -d lost_found_restore --no-owner < backup-YYYY-MM-DD.dump
```

`*.dump` files are git-ignored. Images live separately (volume or S3) and must
be backed up with the database for a consistent restore.

Production (RDS, unverified here): automated backups with point-in-time
recovery, a manual snapshot before every release that contains migrations,
and restores to a **new** instance followed by switching `DATABASE_URL`.
