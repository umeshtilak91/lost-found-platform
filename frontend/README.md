# Web app (Next.js)

Part of the Lost & Found platform. See the [repository README](../README.md)
for setup, [docs/folder-structure.md](../docs/folder-structure.md) for where
code goes, and [docs/testing.md](../docs/testing.md) for the Playwright suites.

```bash
npm ci
npm run dev          # http://localhost:3000 (expects the API on API_INTERNAL_URL, default :5000)
npm run lint && npm run typecheck && npm run build && npm run check:bundle
npm run test:e2e     # against the isolated stack on :3100 (npm run e2e:up from the root)
```
