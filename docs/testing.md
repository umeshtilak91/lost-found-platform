# Testing

| Layer | Tool | Location | Providers | Runs in CI |
|---|---|---|---|---|
| Unit | `node:test` | `backend/test/config.test.js` | none | yes |
| Integration (API + real PostgreSQL) | `node:test` + supertest | `backend/test/*.test.js` | **mocked**: test payment provider, fixture places, captured email | yes |
| Static checks | ESLint, `tsc`, syntax check, `check:bundle` | both apps | — | yes |
| Browser end-to-end | Playwright (desktop Chrome + Pixel 7) + axe | `frontend/e2e/` | **mocked** (fixture places, test payments, Mailpit for real SMTP delivery of codes) against the real web and API containers | yes |
| Real sandbox: Razorpay | Playwright | `frontend/e2e-razorpay/` | **real Razorpay Test Mode** (no real money) | manual (`sandbox.yml`) |
| Real sandbox: Google Places | script | `backend/scripts/verify-google-places.js` | **real Google** (billable quota) | manual (`sandbox.yml`) |
| Secret scanning | gitleaks | repository + history | — | yes |

A mocked payment test proves the application's logic, **not** the Razorpay
integration; only the `e2e-razorpay` suite exercises Razorpay itself.

## Prerequisites

- Node 22 and npm, Docker with Compose v2.
- `npm run setup` (installs both apps from their lockfiles).
- Optional: `brew install gitleaks` for `npm run secrets:scan`.

## Commands (from the repository root)

```bash
npm run lint            # backend syntax check + frontend ESLint
npm run typecheck       # frontend tsc --noEmit
npm run test:db         # start throwaway PostgreSQL on :5544 (container lf-testdb)
npm test                # backend unit + integration tests
npm run build           # frontend production build
npm run check:bundle    # browser assets contain no server secrets (after build)
npm run e2e:up          # isolated stack on :3100 (project lftest, own volumes)
npm run test:e2e        # Playwright, desktop + mobile
npm run e2e:down        # stop the stack and delete its volumes
npm run secrets:scan    # gitleaks (history + source; values redacted)
npm run check           # lint, typecheck, test, build, check:bundle
```

Backend tests use `TEST_DATABASE_URL` (default
`postgres://postgres:test@localhost:5544/postgres`); each test file creates and
drops its own database.

## The isolated e2e stack

`docker-compose.e2e.yml` overrides the dev stack: `NODE_ENV=test`, the test
login fixture, `PLACES_PROVIDER=fixture`, `PAYMENT_PROVIDER=test`, Mailpit on
:8026, API on :5100, `ALLOWED_ORIGINS=http://localhost:3100` and no Resend
key, so tests never send real email, call Google or charge money regardless
of your `.env`. It runs alongside the dev stack without touching its data.

## Two-user tests

Playwright opens **separate browser contexts** for User A (owner) and User B
(finder), each signed in through `POST /api/auth/test-login` (`e2e/fixtures.ts`)
or through the real email-code flow with Mailpit (`e2e/otp.spec.ts`).
`e2e/returns.spec.ts` covers the full journey: report lost → report or find
the found listing → search → claim with ownership answer → contact stays
locked (402) → ₹100 payment (test provider) → chat unlocks → handover →
receipt → listing leaves active search → both see history; plus problem
reports, self-recovery, external returns, corrections and concurrency.

## Real Razorpay Test Mode

1. Put Test Mode keys in `.env` (`PAYMENT_PROVIDER=razorpay`,
   `RAZORPAY_KEY_ID=rzp_test_…`, secret, webhook secret).
2. `E2E_PAYMENT_PROVIDER=razorpay npm run e2e:up`
3. `npm run test:e2e:razorpay`

The suite pays the ₹100 fee with Razorpay's test card, checks the amount
against the Razorpay API and the database, exercises failure, cancellation and
refund, and writes IDs-only evidence to `$E2E_EVIDENCE_DIR` (default: the OS
temp directory). The configuration refuses live keys outside production.

## Test data and cleanup

- Test accounts use generated addresses on reserved domains (`example.com`,
  `*.test`); no fixture contains real personal data.
- Backend test databases are dropped after each file. If a run is killed:
  `docker exec lf-testdb psql -U postgres -c '\l'` and drop leftovers.
- `npm run e2e:down` removes all e2e data. Playwright artifacts
  (`frontend/test-results`, `playwright-report`) are git-ignored.
- Razorpay Test Mode orders remain in the Razorpay Test Dashboard; they never
  involve real money.

## What is not covered automatically

- Real Resend delivery (needs a verified domain; run manually and check Resend logs).
- Google and Apple OAuth end to end (third-party consent screens).
- Real Google Places from CI unless the manual workflow is run with a key.
