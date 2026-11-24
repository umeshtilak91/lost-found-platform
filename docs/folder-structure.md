# Folder structure

The repository keeps the two applications separate (each with its own
`package.json` and lockfile) and organizes code by responsibility inside each.
A root `package.json` only holds developer commands.

```
.
├── backend/                    API (Node 22, Express 5, CommonJS)
│   ├── server.js               entry: API server | `node server.js migrate`; housekeeping timers
│   ├── migrations/             ordered, additive SQL (000_… → 008_…)
│   ├── scripts/                set-role.js, verify-google-places.js, check-syntax.js
│   ├── src/
│   │   ├── app.js              composition root: middleware order, dependencies, routes
│   │   ├── config/             index.js (validated env), pricing.js (fee + rewards)
│   │   ├── auth/               passport strategies, OTP challenges, account linking
│   │   ├── middleware/         security (CSRF, rate limits, roles), errors
│   │   ├── routes/             HTTP entry points by domain: validation + authorization
│   │   ├── services/           business rules (items, matching, connections, returns,
│   │   │                       notifications, locations, images, contact guard, serializers)
│   │   ├── integrations/       provider adapters: places, payments, mailer, storage
│   │   ├── db.js, migrate.js, logger.js, legacyImages.js
│   └── test/                   node:test integration tests against real PostgreSQL
├── frontend/                   Web (Next.js 16 App Router, React 19, Tailwind 4, TypeScript)
│   ├── app/                    routes; route-only components sit beside their page
│   ├── features/               UI grouped by business domain
│   │   ├── auth/               AuthProvider, RequireAuth
│   │   ├── home/               HeroSign
│   │   ├── items/              ItemForm, ItemCards, ImageGallery, ViewedBadge
│   │   ├── search/             HomeSearch, SearchFilters, LocationPicker, LocationSearch
│   │   ├── payments/           Checkout, PricingTable (RewardPanel)
│   │   ├── returns/            MatchPanel (return lifecycle panel)
│   │   ├── moderation/         SupportQueue
│   │   └── admin/              VisitorsChart
│   ├── components/
│   │   ├── ui/                 primitives: Button, Field, Input, Alert, ConfirmDialog, Skeleton…
│   │   └── layout/             Header, ThemeToggle, Toaster, PageViewTracker
│   ├── config/                 env.ts (shared parser), server.ts (server-only values)
│   ├── lib/                    small shared utilities: api client, server-api, i18n,
│   │                           money, pricing hook, location helpers, theme, types
│   ├── scripts/                check-client-bundle.mjs
│   ├── e2e/                    Playwright tests (deterministic, fake providers)
│   └── e2e-razorpay/           Playwright tests against Razorpay Test Mode (manual)
├── deploy/                     helm/lost-found (EKS chart), local/Caddyfile (compose proxy)
├── docs/                       documentation (index in README.md)
├── .github/workflows/          ci.yml (every PR), sandbox.yml (manual provider checks)
├── docker-compose.yml          local stack: db, mailpit, backend, frontend, proxy
└── docker-compose.e2e.yml      overrides for the isolated test stack (project `lftest`)
```

## Where new code belongs

| You are adding | Put it in |
|---|---|
| An API endpoint | `backend/src/routes/<domain>.js`. Parse input with a `.strict()` zod schema and check authorization here; keep the handler short. |
| A business rule or state transition | `backend/src/services/<domain>.js`. Lock rows in id order inside `withTransaction`; make it idempotent. |
| A call to an external provider | `backend/src/integrations/<provider>.js`, behind a small interface with a fake for tests. Never call providers from routes. |
| A setting that differs between environments | `backend/src/config/index.js` (validate it; never log its value) and [environment-variables.md](environment-variables.md). |
| An amount, fee or reward | `backend/src/config/pricing.js` only. Bump `PRICING_VERSION`. The web app reads `GET /api/pricing`. |
| A schema change | A new `backend/migrations/NNN_name.sql`. Additive; never edit an applied file. |
| A page | `frontend/app/<route>/page.tsx`. Prefer server components; fetch with `lib/server-api.ts`. |
| UI for one domain | `frontend/features/<domain>/`. |
| A reusable primitive | `frontend/components/ui/`, only when two or more features need it. |
| A server-only web value | `frontend/config/env.ts` + `config/server.ts`. Never add `NEXT_PUBLIC_*` for secrets. |
| User-visible text | `frontend/lib/i18n/messages.ts`, both `en` and `hi`. |

## Rules

- Features may import `components/`, `lib/` and `config/server.ts` (server components only); `components/` must not import `features/`.
- Client components (`"use client"`) must not import `@/config/server` or
  `server-only` modules; the build fails if they do.
- No duplicate helpers: search `lib/` and `services/` before adding one.
- Tests live beside the app they test (`backend/test`, `frontend/e2e`), so each
  app's tooling and lockfile stay self-contained.
