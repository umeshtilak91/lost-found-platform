# Instructions for coding agents

Read [README.md](README.md), [docs/architecture.md](docs/architecture.md) and
[docs/folder-structure.md](docs/folder-structure.md) before changing code.

## Layout and boundaries

- `backend/` is the API. Code is CommonJS and has no build step.
  - Routes (`src/routes`) validate input with `.strict()` zod schemas and check authorization.
  - Services (`src/services`) hold business rules and state transitions.
  - Provider calls live only in `src/integrations`.
  - Configuration lives only in `src/config`.
- `frontend/` is the Next.js app.
  - Routes go in `app/`, domain UI in `features/<domain>`, and primitives in `components/ui`.
  - Server-only values come from `config/server.ts`. Client components must never import it.
- Amounts live only in `backend/src/config/pricing.js`. The platform charges only the ₹100 connection fee; finder rewards are paid directly and are never added to checkout.
- A return completes only when the owner confirms receipt. A paid fee or a reported handover never completes it.
- Schema changes go in a new, additive file in `backend/migrations/`. Never edit an applied migration.
- All user-facing text goes in `frontend/lib/i18n/messages.ts`, in both `en` and `hi`.

## Safe commands

These are read-only or isolated:

- Run tests: `npm run lint`, `npm run typecheck`, `npm test` (after `npm run test:db`), `npm run build`, `npm run check:bundle`.
- Run browser tests: `npm run e2e:up && npm run test:e2e`. This uses the isolated `lftest` project.
- Scan for secrets: `npm run secrets:scan`.

Ask before running any of these:

- Anything that deletes the dev stack's volumes.
- `docker compose down -v` without `-p lftest`.
- Any command that deploys.
- Anything that uses live payment keys.

## Secrets

- Never print, log, commit or paste secret values: `.env`, `backend/.env`, API keys, webhook secrets, session secrets, database URLs, OTP codes.
- Refer to variables by name only.
- Never add `NEXT_PUBLIC_*` variables for credentials.
- Put real credentials only in git-ignored `.env` files or the platform secret store, never in fixtures or docs.
- If a secret is exposed, say which provider and file are affected (without the value) and that it must be rotated. Removing it from the code does not revoke it.

## Testing expectations

- Run the relevant checks after every change and add tests for changed behavior and security boundaries.
- Label provider coverage honestly: mocked tests do not verify Razorpay, Google or Resend.
- Report results exactly as they came out: PASS, FAIL or BLOCKED, with the reason. Never claim a check passed if it didn't run.

## Working with the repository

- Keep unrelated local changes and untracked files. Don't revert work you didn't make.
- Don't force-push or rewrite shared history.
- Commit or push only when asked.
