# Release report: release-candidate branch

**Recommendation: ready for a staging deployment, not yet for public launch.**

- Every journey that can be tested locally passes, against real PostgreSQL,
  through the real web and API containers, on desktop and mobile.
- The items under [Blocked or remaining](#blocked-or-remaining) must be done
  before production. The main ones are:
  - confirm a live Google sign-in with a rotated secret
  - review the Hindi copy and the legal pages
  - provision AWS resources
  - fix or disable Apple sign-in

## What changed, by journey

### Security, privacy and configuration (`backend/src`)

- **Configuration** (`config.js`)
  - All settings come from environment variables and are checked at startup.
  - The API refuses to start with a weak `SESSION_SECRET`.
  - The test-login fixture cannot be enabled outside `NODE_ENV=test`.
- **Public data** (`services/serializers.js`)
  - Responses are built from an explicit allow-list.
  - Reporter email and phone, precise coordinates, claim answers and messages
    never appear in public API output or in rendered pages and their metadata.
- **Uploads** (`services/images.js`, `routes/media.js`, `legacyImages.js`)
  - Limits on file count, size and pixel dimensions.
  - The real format is detected by decoding the file, not from its name or
    declared type.
  - Images are re-encoded to WebP with EXIF and GPS data stripped, and stored
    under server-generated keys.
  - Stored files are cleaned up if the database write fails.
  - Images are served only through a route that checks visibility, with
    `nosniff` and a sandboxing CSP.
  - The prototype's `/uploads/*` URLs return 410. Old uploads are converted;
    non-images are rejected and never served.
- **Sessions:** stored in PostgreSQL (`connect-pg-simple`), with the session
  ID rotated on login and the session destroyed on logout (POST only). Cookies
  are Secure whenever `APP_URL` is HTTPS.
- **Request protection** (`middleware/security.js`)
  - CSRF tokens plus an Origin/Referer allow-list on every state-changing
    request.
  - helmet headers, with `X-Powered-By` removed.
  - CORS restricted to an explicit allow-list.
  - Rate limits stored in PostgreSQL, so they are shared across replicas, for
    auth, one-time codes, reporting, uploads, contact, claims and abuse reports.
- **Observability:** request IDs, structured logs with redaction (no request
  bodies), `/healthz`, `/readyz` (checks the database, pending migrations and
  storage) and Prometheus `/metrics`.
- **Migrations** (`migrate.js`, `migrations/`)
  - A versioned runner with an advisory lock and checksum tracking.
  - Upgrades prototype databases in place: identities, phone normalization,
    timestamps converted to time-zone-aware, new tables and indexes.
  - Indexes cover browse, search (`pg_trgm`), date, category and ownership
    queries.

### Core journey (`backend/src/routes`, `frontend/app`)

- **Browse:** server-side search across title, location and description, plus
  type, category, status, date range, location text, distance and sorting.
  Pagination is stable (ID as tie-breaker), parameters are validated, and
  filters live in shareable URLs.
- **Listings:** create, edit and delete with up to 5 photos.
  - Status rules are enforced on the server: open → claimed (only by accepting
    a claim) → returned or closed, plus reopen.
  - Only the owner can change a listing.
- **Private contact:** in-app conversations visible only to the two
  participants.
  - A claimant answers the poster's ownership question privately; the poster
    accepts or declines.
  - Phone sharing is opt-in per conversation and can be switched off.
  - Retries and races are safe: duplicate claims are prevented by an index,
    accepts lock the rows, and messages carry a client ID so resends don't
    duplicate.
- **Matching:** matches the opposite listing type by category, title and
  location similarity, date window and distance. Owners can see their matches.
- **Notifications:** for matches, messages, claims, status changes and
  moderation, deduplicated by key. Email delivery goes through SMTP (Mailpit
  locally) after the database commit, and each delivery is logged.
- **Moderation**
  - Users can report listings.
  - Moderators work from a queue and can remove or restore listings or dismiss
    reports. Every action is written to the audit log with a reason.
  - Removed listings return 410 to the public, drop out of search, and their
    images return 404. The owner and moderators can still see them, and the
    CDN copies are purged.
- **Sign-in and account**
  - Google, email one-time codes (HMAC-stored, expiring, single use,
    attempt-limited, replay-safe), and Apple sign-in code (see the risks
    below).
  - Accounts link only on a verified email.
  - Account export (JSON) and deletion.
  - International phone validation (`libphonenumber`).

### Global usability (`frontend/`)

- **Design system:** Tailwind design tokens with light and dark themes,
  reusable components, and inline feedback instead of browser `alert()`.
  Every page has loading, empty, error and success states.
- **Navigation and accessibility:** responsive navigation with a mobile menu
  (Escape closes it and returns focus), a skip link, labelled fields with
  linked hints and errors, and focus moved to the error summary when a form
  fails.
- **Item pages:** rendered on the server, with Open Graph and Twitter
  previews built from public fields only. Missing listings return 404; removed
  ones show a clear notice.
- **Languages and formats:** English and Hindi, chosen by cookie or
  `Accept-Language`. Calendar dates are formatted in UTC so the day never
  shifts; timestamps use the viewer's time zone.
- **Location:** "Use my current location" when adding a listing and "Near me"
  search; the public only sees an approximate area of about 1 km.
- **Legal and retention:** draft privacy and terms pages that match the
  implementation, with items needing review marked; see
  `docs/data-retention.md`.

### Reproducible delivery

- **Docker Compose**
  - A migrate job runs before the API starts.
  - Mailpit catches email locally.
  - Caddy acts as a local ingress: one origin, `/api` routed to the API, and
    the real client IP forwarded.
  - Host ports are configurable.
  - A separate `lftest` project with its own volumes is used for end-to-end
    tests.
- **Images:** run as a non-root user with a health check, and npm/corepack
  removed from the final images.
- **Storage:** a local adapter and an S3 adapter (SSE, `IfNoneMatch` writes,
  batch deletes, CloudFront invalidation).
- **CI** (`.github/workflows/ci.yml`)
  - API integration tests with coverage, web lint, types and build, and
    `npm audit`.
  - Playwright against the Compose stack.
  - Trivy image and IaC scanning; SonarQube when it's configured.
  - ECR publishing via OIDC, only from `main` or `v*` tags, behind the
    `release` environment.
- **Helm chart** (`deploy/helm/lost-found`)
  - Migrations run as a pre-upgrade hook.
  - Probes, security contexts with a read-only root filesystem, HPA, PDB and a
    NetworkPolicy.
  - IRSA, secret references, ALB ingress, ServiceMonitor and alert rules.
  - Staging and production values files.
  - The runbook is in `docs/deployment.md`.

## Test evidence

All runs are from this branch on macOS with Docker Desktop and Node 22.

| Check | Command | Result |
|---|---|---|
| API integration tests (real PostgreSQL 16, fresh database per file) | `cd backend && npm test` | **43/43 pass** |
| API syntax check | `npm run lint` | OK |
| Web lint / types / production build | `npx eslint . && npm run typecheck && npm run build` | Clean, build OK |
| Browser tests (desktop Chrome + Pixel 7, through Caddy → web → API → PostgreSQL) | `npx playwright test` | **31/31 pass** |
| Accessibility (axe, WCAG 2.1 A/AA, serious and critical findings) | in the Playwright suite | 0 violations across public and signed-in pages, desktop and mobile |
| Dependency audit | `npm audit --omit=dev` (both apps) | 0 vulnerabilities after patching `body-parser`, `multer`, `proxy-addr`, and Next 16.2.11 → 16.4.6 |
| Image scan | `trivy image --severity HIGH,CRITICAL --ignore-unfixed` | 0 in both images (16 and 20 before the fixes) |
| IaC scan | `trivy config` on the Dockerfiles and rendered manifests | 0 HIGH/CRITICAL; 12 LOW, accepted (see below) |
| Helm | `helm lint`, `helm template` (staging and production), `kubeconform -strict` (Kubernetes 1.30) | Lint OK; 20 valid, 2 skipped (Prometheus CRDs); the required-value guards fail as intended |
| Prototype upgrade | `migrations.test.js`, plus a live run on your existing local volume | Data kept, valid image converted, HTML upload rejected, re-run does nothing |
| Persistence | `docker compose -p lftest down` then `up` | 447 listings before and after; images still served; migrate job reported "already up to date" |
| Session after API restart | Playwright (`docker compose restart backend`) | Still signed in |
| Email-code login | Live on the dev stack through Mailpit | Code delivered, sign-in and session OK |

The 12 accepted LOW findings are: no CPU limit (deliberate, to avoid
throttling), UID/GID 1000 (the `node` user), and "default namespace" (only
because the manifests were rendered without a namespace).

The browser scenarios cover:

1. Browsing beyond the first 10 listings, with filters and direct links.
2. Create with photos, edit, and refresh.
3. Private contact, claim, notification, accept and return.
4. Third-user isolation, and no private fields in the API or the HTML.
5. Uploads: valid, wrong format, disguised HTML and too large, with no partial
   data left behind.
6. Report, moderator removal, and the public effect on search, link and image.
7. Logout, and session persistence across an API restart.
8. Mobile layout, axe checks, keyboard-only use of the skip link, search,
   report form and contact.
9. Hindi locale, notification and message deduplication, and double-submitted
   or concurrent claims.

### What was not verified

- **Browser tests use a test-only login**, not live Google OAuth. It exists
  only when `NODE_ENV=test` and `ENABLE_TEST_AUTH=true`, and the API refuses
  to start with it in any other mode.
- **Live Google sign-in:** only partly verified. With the supplied client,
  the app redirects to Google and Google accepts the callback URL
  `http://localhost:5000/api/auth/google/callback`, so there is no
  `redirect_uri_mismatch`. Nobody completed a sign-in with a Google account,
  because that needs a person to log in.
- **Deployment:** validated locally only (lint, template, schema and scan).
  **Nothing was deployed to EKS**, and no AWS resources were created.

## Setup

```bash
cp .env.example .env          # set SESSION_SECRET, DB_PASSWORD, GOOGLE_* (optional)
docker compose up -d --build  # app http://localhost:3000, mail http://localhost:8025
docker compose exec backend node scripts/set-role.js you@example.com moderator
```

| Purpose | Variables |
|---|---|
| Required | `SESSION_SECRET`, plus `DATABASE_URL` or `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, and `APP_URL` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| Email | `SMTP_URL`, `MAIL_FROM`, `EMAIL_LOGIN_ENABLED`, `NOTIFICATION_EMAILS` |
| Storage | `STORAGE_DRIVER` (local or s3), `STORAGE_LOCAL_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `CLOUDFRONT_DISTRIBUTION_ID`, `LEGACY_UPLOADS_DIR` |
| Network | `TRUST_PROXY`, `ALLOWED_ORIGINS`, `COOKIE_SECURE` |
| Tuning | `RATE_LIMIT_MULTIPLIER`, `UPLOAD_MAX_FILES`, `UPLOAD_MAX_FILE_MB`, `UPLOAD_MAX_MEGAPIXELS`, `LOG_LEVEL`, `METRICS_ENABLED`, `DB_SSL` |
| Host ports | `APP_HOST_PORT`, `API_HOST_PORT`, `DB_HOST_PORT`, `MAIL_UI_HOST_PORT` |

Migration order, rollout verification, rollback and recovery are in
`docs/deployment.md`. In short:

1. Take an RDS snapshot.
2. The Helm pre-upgrade Job runs the additive migrations.
3. Pods report ready only once migrations are complete.
4. Roll back with `helm rollback`, since the old image works with the new
   schema. Fix migrations forward; restore from snapshot or PITR as a last
   resort.

## Blocked or remaining

| Item | Impact | What's needed |
|---|---|---|
| **Rotate the Google client secret** | It was shared in plain text in chat | Google Cloud Console → Credentials → reset the secret → update `.env` |
| Register `http://localhost:3000/api/auth/google/callback`, or the production `https://<host>/api/auth/google/callback` | Locally the workaround is `GOOGLE_CALLBACK_URL` pointing at port 5000. Production needs the HTTPS URL. | Add the URI to the OAuth client's authorized redirect URIs |
| Live Google sign-in test | The full OAuth round trip hasn't been seen working | Sign in once at http://localhost:3000/login |
| **Apple sign-in: untested, likely broken as written** | Apple posts the callback cross-site (`form_post`). The session cookie is `SameSite=Lax`, so the browser won't send it and the OAuth state check will probably fail. | Apple developer credentials, plus a state cookie with `SameSite=None; Secure` for that route (or a stateless signed state). Leave Apple unconfigured until then. |
| Phone (SMS) one-time codes | Not implemented; email codes cover passwordless login | An SMS provider (e.g. SNS or Twilio) and DLT registration for India |
| External notifications | Only email is implemented; push, SMS and WhatsApp are not | Provider choice and credentials |
| Map-based location picker | Only "use my location" and text entry exist | Choose a map tile provider and its terms |
| Hindi copy | Drafted, not reviewed by a fluent speaker | Review `frontend/lib/i18n/messages.ts` |
| Privacy and terms | Drafts; the entity, contacts, retention periods and jurisdiction are placeholders | Owner and legal review (DPDP Act 2023, plus GDPR if serving the EU) |
| AWS provisioning and EKS rollout | Not done; needs authorization and incurs cost | See the prerequisites in `docs/deployment.md` |
| CI on GitHub | The workflow is written but not run on GitHub | Push the branch, then set `SONAR_HOST_URL`/`SONAR_TOKEN`, the `AWS_*` and `ECR_*` variables, and the `release` environment |
