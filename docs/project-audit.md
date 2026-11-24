# Project audit

Date: 2026-11-24. Branch audited: `release-candidate`, at commit `3f3da11`.
No secret values appear in this document.

## Current architecture (as found)

| Area | Technology | Notes |
|---|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind 4, TypeScript | Server-rendered browse/detail pages; 22 components in a flat `components/` folder. |
| Backend | Node 22, Express 5, zod v4, Passport, pino | Already layered: `routes/` → `services/`, plus `auth/`, `middleware/`, `storage/`. |
| Database | PostgreSQL 16 | 9 ordered SQL migrations (`000`–`008`); 24 tables. |
| Authentication | Email OTP (Resend/SMTP), Google OAuth, Apple (wired, unverified); sessions in PostgreSQL | Test-login fixture only under `NODE_ENV=test`. |
| Payments | Razorpay Standard Checkout; local test provider with the same contract | Order amount fixed server-side at ₹100. |
| Email | Resend HTTP API, SMTP fallback (Mailpit locally) | |
| Location | Google Places API (New) and Geocoding via a server proxy; offline fixture provider | |
| Storage | Local volume or private S3 (+ CloudFront purge) | |
| Deployment | Docker Compose; Helm chart for EKS; GitHub Actions CI (lint, tests, Playwright, Trivy, optional Sonar, ECR publish) | |
| Background jobs | Hourly housekeeping inside the API process (purges, return reminders, coordinate refresh) | |

Inventory:
- About 75 API endpoints (see [api.md](api.md)).
- 19 web pages and route handlers.
- 128 backend tests.
- 129 Playwright test runs (6 spec files, desktop and mobile projects).
- 1 manual Razorpay Test Mode suite.

## Feature inventory and status

| Feature | Status | Evidence |
|---|---|---|
| Email OTP sign-in | Working | backend `auth-account.test.js`, e2e `otp.spec.ts`; live Resend delivery verified earlier, but only to the account owner's address |
| Google sign-in | Working locally | Manual check (Google consent page reached). Callback is `localhost:5000`. |
| Apple sign-in | **Unverified** | No credentials configured |
| Lost/found reporting with photos | Working | `journeys.spec.ts`, `security.test.js` |
| Category rewards | Working | `payments.test.js`, `pricing.spec.ts` |
| Google Places suggestions, permission handling | Working | `locations.test.js`, `locations.spec.ts`; live Google check passed earlier |
| Search and distance filters | Working | as above |
| Claims and ownership verification | Working | `journeys.test.js`, `journeys.spec.ts` |
| ₹100 Razorpay fee | Working in Test Mode | `payments.test.js` (mocked), `e2e-razorpay` (real Test Mode, run earlier) |
| Contact-access rules | Working | 402 `connection_locked` tests |
| Messaging and notifications | Working | `journeys.*` |
| Handover and receipt confirmation | Working | `returns.test.js`, `returns.spec.ts` |
| Active vs completed history | Working | `returns.*` |
| Account, moderation, administration | Working | `auth-account.test.js`, `platform.spec.ts` |
| Light/dark themes, responsive layouts | Working | `platform.spec.ts` |
| **Warm Charcoal theme** | **Not present** | It was started in an earlier session, then stopped and fully reverted at the owner's explicit request. This restructure keeps it that way. Discrepancy with the task brief recorded here; not re-implemented. |

## Key problems found

1. **Personal data in history.** `frontend/otp-live.tmp.mjs`, a throwaway script, was tracked. It contained the owner's real email address and machine-specific paths.
2. **No real credentials in history.** gitleaks scanned 164 commits and the tracked files. Its only hit was a fixed test UUID in `backend/test/locations.test.js`, a false positive. Real keys exist only in the git-ignored `.env` and `backend/.env`.
3. **Some configuration was not validated:**
   - Malformed numbers silently fell back to defaults.
   - Errors stopped at the first problem.
   - The web app read `process.env` in three places.
4. **Duplicated display amount.** The ₹100 fallback (`10000`) was repeated in five frontend files. The authoritative amounts were already centralized in the backend.
5. **Flat frontend components folder.** Domain components were mixed with UI primitives.
6. **Provider adapters mixed into business services.** `services/places.js`, `payments.js` and `mailer.js` sat alongside the business rules.
7. **The e2e stack inherited `ALLOWED_ORIGINS` from the developer's `.env`.** After the tunnel was added, a third of the browser suite failed.
8. **Unused boilerplate.** Five `create-next-app` SVGs and the template frontend README.
9. **Missing documentation:** environment variable reference, API reference, user/admin guides, contributor/agent/security policies.
10. **CI gaps:**
    - No secret scanning.
    - No check for server secrets in browser bundles.
    - The ECR publish job would fail on a repository without AWS variables.
11. **User-facing text named internal variables.** The Google sign-in message named `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
12. **The Razorpay e2e suite wrote to a machine-specific temp path.**
13. **`.env.example` is protected.** A local hook blocks edits to it, so the improved template is supplied separately (see [release-checklist.md](release-checklist.md)).

## Changes made

| # | Change |
|---|---|
| 1 | Untracked the temp script and ignored `*.tmp.mjs`. The new repository starts from a **clean single-commit snapshot**, so no historical file is inherited. The original repository and its remotes are untouched. |
| 3 | `backend/src/config/index.js`:<br>- collects every problem and names the variables, never the values<br>- validates integers, URLs and Razorpay key format<br>- refuses live Razorpay keys outside production<br><br>`frontend/config/env.ts` + `config/server.ts` (server-only) are the web app's single parser. |
| 4 | `FALLBACK_CONNECTION_FEE_PAISE` in `frontend/lib/money.ts` (display only). `backend/src/config/pricing.js` validates the table at start-up. |
| 5 | `frontend/features/<domain>/`, `components/ui`, `components/layout`. |
| 6 | `backend/src/integrations/{places,payments,mailer,storage}.js`; `pricing.js` → `config/`. |
| 7 | `docker-compose.e2e.yml` pins `ALLOWED_ORIGINS`. |
| 8 | Removed the boilerplate files; added `public/.gitkeep`. |
| 9 | Documentation set (see README index). |
| 10 | CI changes:<br>- a gitleaks job (full history)<br>- a `check:bundle` step<br>- the publish job gated on its variables<br>- a manual `sandbox.yml` for real Razorpay Test Mode and Google checks |
| 11 | Reworded (en/hi). |
| 12 | `E2E_EVIDENCE_DIR`, defaulting to the OS temp directory. |
| — | Root `package.json` with standard commands; `.gitleaks.toml`; extended `.gitignore`; new unit tests (`config.test.js`). |

## Compatibility risks and mitigation

| Risk | Mitigation |
|---|---|
| Public API contract | No routes, payloads or status codes changed. |
| Database | No schema changes; no new migrations. |
| Stricter configuration could stop a previously-running deployment | Only malformed values are newly rejected (non-integer ports/limits, non-URL `APP_URL`, badly-formed Razorpay key ID, live key outside production). The error names each variable. The local dev stack was restarted on the new code to confirm. |
| Moved modules | `require("./config")` still resolves (`config/index.js`). All imports were updated and checked by the syntax check, `tsc`, ESLint, the production build and the full test suites. |
| Storage paths after moving `config.js` | The default `STORAGE_LOCAL_DIR`/`LEGACY_UPLOADS_DIR` were recomputed for the new depth; compose sets explicit paths anyway. |
| New repository history | The clean snapshot drops the prior commit history (it contained personal data). The full history stays in the original repository. |
