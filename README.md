# Lost & Found Platform

People report lost or found items, find each other by place and distance,
prove ownership privately and complete the return. Contact details stay
private until the owner pays a ₹100 connection fee for an accepted match. The
finder reward is paid directly between the two people, never through the
platform.

## Implemented features

- **Sign-in:** email one-time codes (Resend or SMTP) plus optional Google OAuth. Apple Sign in is wired up but unverified.
- **Listings:** lost and found reports with up to 5 photos. Photos are re-encoded with metadata stripped, contact details are blocked in public text, and posters can edit, close or delete.
- **Location:** Google Places suggestions through a server proxy (the key never reaches the browser), "Use my location" with every permission state handled, a country control, and a 2/5/10/25 km radius or "Anywhere". Distances are approximate.
- **Search:** keyword, type, category, date and distance, with server-side pagination.
- **Claims:** a private ownership question and answer, then the poster accepts or declines.
- **Rewards and fee:** each category has a reward, snapshotted per match. The platform charges only the ₹100 fee, through Razorpay Standard Checkout (or a local test provider). Payment is checked by signature, webhook and reconciliation.
- **Contact:** chat and optional phone sharing unlock only after payment.
- **Returns:** "Return being arranged" → finder reports handover → owner confirms receipt → Returned. Also covers problem reports, "I found it myself", returns made outside the platform, corrections and reminders. Completed returns leave active search and appear in both people's history.
- **Notifications:** in-app, plus email when configured.
- **Account:** profile, phone sharing, data export, account deletion.
- **Moderation:** abuse reports, remove/restore with an audit log, a support queue (refunds, return issues, corrections) and visitor analytics.
- **Interface:** English and Hindi, light and dark themes, responsive layout, accessibility checks with axe.

The "Warm Charcoal" theme is **not** in this codebase. It was started and then
reverted at the owner's request (see [docs/project-audit.md](docs/project-audit.md)).

## Technology

| Part | Stack |
|---|---|
| Web (`frontend/`) | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| API (`backend/`) | Node 22, Express 5, Passport, zod, pino, sharp |
| Data | PostgreSQL 16; images on local disk or a private S3 bucket |
| Providers | Razorpay, Google Maps Platform (Places API (New), Geocoding), Resend/SMTP, Google OAuth |
| Delivery | Docker Compose (local), Helm chart for EKS, GitHub Actions |

## Quick start

Requirements: **Docker** with Compose v2, **Node 22** and npm (for tests and
tooling), `openssl`.

```bash
git clone <this repository> && cd lost-and-found-platform
cp .env.example .env
# Edit .env: set SESSION_SECRET (openssl rand -hex 32). Everything else is optional.
npm run setup        # install both apps from their lockfiles
npm run dev          # build and start db, mailpit, migrate, api, web, proxy
```

- App: http://localhost:3000
- Email inbox for sign-in codes (Mailpit): http://localhost:8025
- API health: http://localhost:5000/healthz (set `API_HOST_PORT=5001` if macOS AirPlay is using port 5000)

Database migrations run automatically before the API starts (`npm run migrate`
runs them by hand). To make yourself a moderator, sign in once and then run
`docker compose exec backend node scripts/set-role.js you@example.com moderator`.

## Commands

| Command | Does |
|---|---|
| `npm run dev` / `dev:logs` / `dev:down` | Start / follow logs / stop the local stack |
| `npm run migrate` | Apply pending migrations |
| `npm run lint`, `npm run typecheck` | Static checks |
| `npm run test:db` then `npm test` | Backend unit and integration tests (throwaway PostgreSQL on :5544) |
| `npm run build`, `npm run check:bundle` | Production web build, then a scan of browser assets for secrets |
| `npm run e2e:up`, `npm run test:e2e`, `npm run e2e:down` | Browser tests on an isolated stack (:3100) |
| `npm run test:e2e:razorpay` | Optional real Razorpay **Test Mode** suite |
| `npm run secrets:scan` | gitleaks over history and source |
| `npm run check` | lint, typecheck, test, build, bundle check |

## Documentation

| Topic | Page |
|---|---|
| Architecture and data flow | [docs/architecture.md](docs/architecture.md) |
| Folder structure and where code goes | [docs/folder-structure.md](docs/folder-structure.md) |
| Environment variables | [docs/environment-variables.md](docs/environment-variables.md) |
| HTTP API | [docs/api.md](docs/api.md) |
| Database, migrations, backups | [docs/database.md](docs/database.md) |
| Payments: fee vs reward | [docs/payments.md](docs/payments.md) |
| Return lifecycle | [docs/returns.md](docs/returns.md) |
| Locations and Google Places | [docs/locations.md](docs/locations.md) |
| User guide | [docs/user-guide.md](docs/user-guide.md) |
| Admin and moderation | [docs/admin-guide.md](docs/admin-guide.md) |
| Testing | [docs/testing.md](docs/testing.md) |
| Deployment | [docs/deployment.md](docs/deployment.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Data retention | [docs/data-retention.md](docs/data-retention.md) |
| Project audit | [docs/project-audit.md](docs/project-audit.md) |
| Test report | [docs/test-report.md](docs/test-report.md) |
| Release checklist | [docs/release-checklist.md](docs/release-checklist.md) |
| Earlier release report (historical) | [docs/release-report.md](docs/release-report.md) |

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md). Agents: [AGENTS.md](AGENTS.md).
