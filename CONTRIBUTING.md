# Contributing

## Local workflow

1. `cp .env.example .env` and set `SESSION_SECRET`. See [docs/environment-variables.md](docs/environment-variables.md).
2. Install and start: `npm run setup`, then `npm run dev`. The app runs at http://localhost:3000 and sign-in codes arrive in Mailpit at http://localhost:8025.
3. Pick up changes:
   - API: `docker compose up -d --build backend`.
   - Web: `docker compose up -d --build frontend`.
   - To develop the web app outside Docker: `cd frontend && npm run dev` (port 3000, so stop the compose proxy first).
4. Put code where [docs/folder-structure.md](docs/folder-structure.md) says it belongs.

## Branches and commits

- Branch from `main`: `feature/<short-name>`, `fix/<short-name>` or `docs/<short-name>`.
- Write commit messages in the imperative mood, with a short subject (≤ 72 characters) and a body that explains why, for example: `Refuse live Razorpay keys outside production`.
- Keep commits focused. Don't mix refactors with behavior changes.

## Pull requests

- Describe the change, its user impact and how you tested it (commands and results).
- Update docs in the same pull request when behavior, configuration or the API changes.
- Schema changes need a new additive migration and a note on rollback.
- Changes to amounts need `PRICING_VERSION` bumped and [docs/payments.md](docs/payments.md) updated.
- Never include secrets, real personal data or screenshots containing either.

## Required checks

CI (`.github/workflows/ci.yml`) must pass:

- secret scan
- backend lint and integration tests
- web lint, typecheck, build and bundle check
- Playwright browser tests
- image/IaC scan

Run `npm run check` locally first, and run `npm run test:e2e` for anything that affects the UI.
