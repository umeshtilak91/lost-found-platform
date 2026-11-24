# Environment variables

All environment-specific settings and every credential come from environment
variables. There is one parser per process:

| Process | Parser | When it runs |
|---|---|---|
| API (`backend/`) | `backend/src/config/index.js` → `loadConfig()` | At start-up. Invalid configuration stops the process with one error that lists every problem by variable **name** (values are never echoed). |
| Web (`frontend/`) | `frontend/config/env.ts` → `readWebEnv()`; server code imports `frontend/config/server.ts` (`server-only`) | `next.config.ts` at build time; server components at request time. |

Business rules are **not** environment variables. The ₹100 connection fee and
the category rewards live in `backend/src/config/pricing.js`, are validated
at start-up and exposed read-only at `GET /api/pricing`.

## Where values go

| Context | Put values in |
|---|---|
| Local (docker compose) | `.env` in the repository root (git-ignored). Copy `.env.example`. Compose passes values to the containers. |
| Local API outside Docker | `backend/.env` (git-ignored), loaded by `dotenv` in `backend/server.js`. Real environment variables take priority. |
| Browser tests | `docker-compose.e2e.yml` sets test values itself (`NODE_ENV=test`, fixture places, test payments, Mailpit). |
| CI | GitHub Actions generates throwaway `SESSION_SECRET`/`DB_PASSWORD` per run. Sandbox checks read repository **secrets** (see `.github/workflows/sandbox.yml`). |
| Production | The platform secret store (e.g. Kubernetes Secret synced from AWS Secrets Manager; see [deployment.md](deployment.md)). Never a committed file. |

## Restart or rebuild?

- **API variables** take effect after restarting the API: `docker compose up -d backend`.
- **Web variables** (`API_INTERNAL_URL`, `APP_URL` for the web container) are
  read by `next.config.ts` at **build time** (rewrites, CSP) and by server
  components at request time. Rebuild the web image after changing them:
  `docker compose up -d --build frontend`.
- There are **no `NEXT_PUBLIC_*` variables**. Anything with that prefix would be
  inlined into browser JavaScript at build time and readable by every
  visitor; moving a value into such a variable does not make it secret. The
  browser obtains the Razorpay key ID at runtime from `GET /api/payments/config`,
  and every Google Maps call is proxied by the API.
- `npm run check:bundle` (CI runs it) fails the build if browser assets contain
  server variable names, credential-shaped strings or the values from your
  local `.env` files.

## Reference

Visibility: **server** = never sent to browsers; **public** = sent to browsers by design.

### Core

| Variable | Required | Visibility | Default | Purpose |
|---|---|---|---|---|
| `SESSION_SECRET` | **yes** | server | — | Signs session cookies; derives test-provider secrets. ≥ 32 characters; placeholders refused in production. `openssl rand -hex 32`. |
| `NODE_ENV` | no | server | `development` (compose: `production`) | `test` enables test-only switches; `production` refuses fake providers. |
| `APP_URL` | no | server | `http://localhost:3000` | Public web origin. Must be an absolute http(s) URL. OAuth callbacks and secure-cookie default derive from it. |
| `ALLOWED_ORIGINS` | no | server | `APP_URL` | Comma-separated origins accepted by the CSRF origin check (e.g. a tunnel URL). |
| `PORT` | no | server | `5000` | API listen port (1–65535). |
| `TRUST_PROXY` | no | server | `1` | Express `trust proxy` hop count. |
| `LOG_LEVEL` | no | server | `info` (`warn` in tests) | pino log level. |
| `COOKIE_SECURE` | no | server | true when `APP_URL` is https | Force the Secure cookie flag. |
| `SESSION_COOKIE_NAME` | no | server | `lf.sid` | Session cookie name. |
| `SESSION_MAX_AGE_HOURS` | no | server | `336` | Session lifetime. |
| `RATE_LIMIT_MULTIPLIER` | no | server | `1` | Scales every rate limit (tests use a large value). |
| `METRICS_ENABLED` | no | server | `true` | Exposes `/metrics` (Prometheus). |

### Database

| Variable | Required | Visibility | Default | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | one of URL or `DB_*` | server (secret) | — | Full PostgreSQL URL. Takes priority over `DB_*`. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` | no | server | `localhost`, `5434`, `postgres`, `lost_found_db` | Discrete connection settings. |
| `DB_PASSWORD` | yes for compose | server (secret) | — | Postgres password; compose uses it to create the database container. |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | no | server | `false`, `true` | TLS to the database (RDS: `DB_SSL=true`). |
| `DB_POOL_MAX` | no | server | `10` | Connection pool size (1–200). |

### Sign-in

| Variable | Required | Visibility | Purpose / where to get it |
|---|---|---|---|
| `RESEND_API_KEY` | no | server (secret) | Resend API key (resend.com → API Keys). Enables email codes and notification emails. |
| `EMAIL_FROM` (alias `MAIL_FROM`) | with Resend | server | Sender on a domain verified in Resend. `onboarding@resend.dev` only delivers to your own Resend account address. |
| `SMTP_URL` | no | server (secret) | SMTP fallback when Resend is not set (compose default: Mailpit). |
| `EMAIL_LOGIN_ENABLED` | no | server | Default: on when Resend or SMTP is configured. |
| `NOTIFICATION_EMAILS` | no | server | Default: on when Resend or SMTP is configured. |
| `EMAIL_TIMEOUT_MS` | no | server | Default `10000`. |
| `OTP_TTL_MINUTES`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_MAX_REQUESTS_PER_EMAIL`, `OTP_REQUEST_WINDOW_MINUTES` | no | server | Defaults 5, 60, 5, 5, 30. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | server (secret is secret) | Google Cloud Console → APIs & Services → Credentials → OAuth client. Both needed to show Google sign-in. |
| `GOOGLE_CALLBACK_URL` | no | server | Default `${APP_URL}/api/auth/google/callback`. Must match an authorized redirect URI exactly. |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_CALLBACK_URL` | no | server (key is secret) | Apple Sign in. All four needed. Unverified end to end (see [release-checklist.md](release-checklist.md)). |
| `ENABLE_TEST_AUTH` | no | server | Test-only login fixture. **Refused unless `NODE_ENV=test`.** |

### Payments (₹100 connection fee only)

| Variable | Required | Visibility | Purpose / where to get it |
|---|---|---|---|
| `PAYMENT_PROVIDER` | no | server | `test` (default; local fake, no money) or `razorpay`. `test` is refused in production unless `ALLOW_TEST_PAYMENTS=true`. |
| `RAZORPAY_KEY_ID` | with razorpay | **public** | Razorpay Dashboard → Account & Settings → API Keys. Must look like `rzp_test_…`/`rzp_live_…`. Live keys are refused when `NODE_ENV` is not `production` (override: `ALLOW_LIVE_PAYMENTS_OUTSIDE_PRODUCTION=true`). |
| `RAZORPAY_KEY_SECRET` | with razorpay | server (secret) | Same page as the key ID. |
| `RAZORPAY_WEBHOOK_SECRET` | with razorpay | server (secret) | The secret you set when creating the webhook `${APP_URL}/api/payments/webhook`. |

### Location (Google Maps Platform)

| Variable | Required | Visibility | Purpose |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | with `PLACES_PROVIDER=google` | server (secret) | Used only by the API proxy. Enable **Places API (New)** and **Geocoding API**; restrict the key to those APIs and to your server's egress IPs (an IP-restricted server key, not an HTTP-referrer key). |
| `PLACES_PROVIDER` | no | server | `google` (default when a key is set), `fixture` (offline demo data; default in tests; refused in production) or `none`. |
| `PLACES_TIMEOUT_MS` | no | server | Default `4000`. |
| `PLACES_COORDINATE_MAX_AGE_DAYS` | no | server | Default `30` (Google caching terms). |

### Storage and uploads

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` (Docker volume) or `s3`. |
| `STORAGE_LOCAL_DIR` | `backend/storage` | Local image directory. |
| `S3_BUCKET` (required with s3), `S3_REGION`/`AWS_REGION`, `S3_PREFIX`, `CLOUDFRONT_DISTRIBUTION_ID` | — | Private bucket; AWS credentials come from the standard AWS chain (IRSA/instance role). |
| `LEGACY_UPLOADS_DIR` | `backend/uploads` | Prototype uploads converted by `migrate`. |
| `UPLOAD_MAX_FILES`, `UPLOAD_MAX_FILE_MB`, `UPLOAD_MAX_MEGAPIXELS`, `UPLOAD_MAX_DIMENSION` | 5, 8, 40, 10000 | Upload limits. |

### Web app (`frontend/`)

| Variable | Default | When read | Purpose |
|---|---|---|---|
| `API_INTERNAL_URL` | `http://localhost:5000` (image: `http://backend:5000`) | build (rewrites) and request (server fetches) | Where the Next.js server reaches the API. Server-only; never exposed. |
| `APP_URL` | `http://localhost:3000` | request | Absolute URLs in page metadata. |

### Docker compose only

| Variable | Default | Purpose |
|---|---|---|
| `APP_HOST_PORT`, `API_HOST_PORT`, `DB_HOST_PORT` | 3000, 5000, 5434 | Host ports. macOS AirPlay uses 5000: set `API_HOST_PORT=5001`. |
| `E2E_PAYMENT_PROVIDER` | `test` | Payment provider for the isolated e2e stack (`razorpay` only for the sandbox suite). |

## Key restrictions to configure at the provider

| Provider | Restriction |
|---|---|
| Google Maps | API restriction: Places API (New) + Geocoding API only. Application restriction: IP addresses of the API servers. Set a daily quota. |
| Google OAuth | Authorized redirect URIs: exactly `${APP_URL}/api/auth/google/callback` per environment. |
| Razorpay | Test Mode keys everywhere except production. Webhook secret unique per environment. |
| Resend | A sending-only API key scoped to the verified domain. |
