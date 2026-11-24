# Release checklist

Status as of 2026-11-24. Evidence: [test-report.md](test-report.md).

## Completed verification

- [x] Backend unit + integration tests: 136/136, against real PostgreSQL 16.
- [x] Browser end-to-end tests: 129/129, desktop and mobile, against the real web and API containers with mocked providers.
- [x] Real Razorpay **Test Mode** two-user journey ([test-report.md](test-report.md#real-sandbox-razorpay-test-mode)).
- [x] Real Google Places (New) and Geocoding: autocomplete, details and reverse geocoding.
- [x] Lint, typecheck, production build.
- [x] Browser bundle contains no server secrets (`check:bundle`).
- [x] `server-only` boundary: a client import of server config fails the build.
- [x] gitleaks over the full history and the new snapshot: no leaks.
- [x] The local stack runs the restructured code with the real local configuration.

## Remaining setup (owner)

- [ ] **Apply the improved `.env.example`.**
  - A local protection hook blocks automated edits to it.
  - The proposed text is in the handover message (scratchpad file `env.example.proposed`).
  - The current tracked file already holds only placeholders.
- [ ] Enable **private vulnerability reporting** in the new repository (Settings → Code security).
- [ ] Add repository secrets before running `sandbox.yml`:
  - `RAZORPAY_TEST_KEY_ID`, `RAZORPAY_TEST_KEY_SECRET`, `RAZORPAY_TEST_WEBHOOK_SECRET`
  - `GOOGLE_MAPS_API_KEY_TEST`
- [ ] Before production:
  - Verify a Resend sending domain and set `EMAIL_FROM` on it. Today, codes only deliver to the Resend account owner's address.
  - Register production OAuth callback URLs.
  - Create the Razorpay **Live** webhook and secret.
  - Restrict the Google Maps key to Places API (New) + Geocoding API and the server egress IPs.
- [ ] Provision hosting. The EKS runbook in [deployment.md](deployment.md) is unverified.
- [ ] Legal review of the terms and privacy pages; review of the Hindi copy.

## Known limitations

- **Warm Charcoal theme:** not implemented. It was reverted on request; light and dark themes ship.
- **Apple Sign in:** unverified (no credentials).
- **Google OAuth:**
  - Verified only up to Google's consent page.
  - The local callback is `localhost:5000`, so a tunnel URL can't complete Google sign-in.
- **Razorpay webhooks:** can't reach localhost. Local runs rely on checkout verification and reconciliation; webhook handling is covered by signed-webhook integration tests.
- **Background jobs:** run inside the API process (no separate worker).
- **Cloudflare quick-tunnel URL:** changes on every reconnect.
- **New repository history:** starts with a clean snapshot. The full history remains in the original repository.

## Required credential rotation

Credentials for these providers were shared in chat sessions during development.
Being out of git does not make it safe. Rotate each one (steps in
[SECURITY.md](../SECURITY.md#rotation)):

- [ ] Google Maps API key
- [ ] Google OAuth client secret
- [ ] Razorpay Test Mode key secret and webhook secret
- [ ] Resend API key
- [ ] `SESSION_SECRET`, if it was ever shared (rotating it ends all sessions)

No credential values appear in tracked files or git history (gitleaks).
