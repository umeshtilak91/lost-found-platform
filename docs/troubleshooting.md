# Troubleshooting

## Configuration

| Symptom | Cause and fix |
|---|---|
| API exits with `Invalid configuration:` and a list | Each line names a variable and the rule it broke (values are never printed). Fix them in `.env` (local) or the secret store, then restart: `docker compose up -d backend`. Reference: [environment-variables.md](environment-variables.md). |
| `SESSION_SECRET must be set to at least 32 characters` | `openssl rand -hex 32` → `.env`. |
| `RAZORPAY_KEY_ID is a live key but NODE_ENV is not production` | Use Test Mode keys (`rzp_test_…`) outside production. |
| `PAYMENT_PROVIDER=test is not allowed in production` | Set `PAYMENT_PROVIDER=razorpay` with keys, or `ALLOW_TEST_PAYMENTS=true` for a private demo only. |
| A web setting change has no effect | `API_INTERNAL_URL` is baked into the web image at build time: `docker compose up -d --build frontend`. |
| Port 5000 in use on macOS | AirPlay Receiver. Turn it off or set `API_HOST_PORT=5001`. |

## Email sign-in and OTP

| Symptom | Cause and fix |
|---|---|
| "Email sign-in is not configured" (503 `email_unconfigured`) | Neither `RESEND_API_KEY` nor `SMTP_URL` is set. Locally, compose uses Mailpit. |
| Code never arrives (Resend) | `EMAIL_FROM` must be on a domain verified in Resend; `onboarding@resend.dev` only delivers to your own Resend account address. Check Resend → Logs. |
| Code never arrives (local) | Open Mailpit at http://localhost:8025 (e2e stack: http://localhost:8026). |
| "Wait before requesting another code" | Resend cooldown (`OTP_RESEND_COOLDOWN_SECONDS`, default 60) or the per-email window limit. |
| "Code expired" / "too many attempts" | Codes last `OTP_TTL_MINUTES` (5) and lock after `OTP_MAX_ATTEMPTS` (5). Request a new code. |
| Google sign-in error `redirect_uri_mismatch` | The callback must exactly match an authorized redirect URI in Google Cloud Console. Keep `APP_URL` and `GOOGLE_CALLBACK_URL` consistent; a temporary tunnel URL needs its own registered callback. Use `ALLOWED_ORIGINS` to add a tunnel without changing the callback. |

## Maps and location

| Symptom | Cause and fix |
|---|---|
| "Suggestions unavailable"; typing still works | `GOOGLE_MAPS_API_KEY` empty or `PLACES_PROVIDER=none`. |
| 503 `location_service_unavailable`, reason `key_invalid` / `api_disabled` / `billing` / `referrer_blocked` / `quota` | Google Cloud: enable **Places API (New)** and **Geocoding API**, attach billing, use an **IP-restricted** server key (an HTTP-referrer restriction blocks server calls), check quotas. Verify with `cd backend && node scripts/verify-google-places.js` (never prints the key). |
| "Use my location" does nothing / permission denied | The browser blocked geolocation. Allow it in site settings, or type a place. Geolocation needs HTTPS (or localhost). |

## Payments and webhooks

| Symptom | Cause and fix |
|---|---|
| Checkout doesn't open | Content-Security-Policy allows `checkout.razorpay.com`; check the browser console and ad blockers. `GET /api/payments/config` must return a `keyId`. |
| Paid but chat still locked | Reload the match: `GET /api/claims/:id/payment` reconciles with Razorpay. A payment captured after the match closed opens a refund request instead of unlocking. |
| Webhook returns 400 | Signature mismatch: `RAZORPAY_WEBHOOK_SECRET` must equal the secret set on that webhook in the same mode (Test vs Live). |
| Webhooks never arrive locally | Razorpay can't reach localhost. Expose the API with a tunnel and register `https://<tunnel>/api/payments/webhook` in Test Mode; reconciliation covers you meanwhile. |
| `amount_mismatch` | The provider reported a different amount or currency than ₹100 INR; nothing unlocks. Investigate in the Razorpay Dashboard. |

## Database

| Symptom | Cause and fix |
|---|---|
| `/readyz` returns 503 | Database unreachable or migrations pending. `docker compose logs migrate backend`. |
| Checksum drift warning | An applied migration file was edited. Restore it and add a new migration instead. |
| Password authentication failed after changing `DB_PASSWORD` | The password is set only when the volume is first created. Change it with `ALTER USER` or recreate the volume (deletes local data). |
| Backend tests can't connect | Start the test database: `npm run test:db` (port 5544), or set `TEST_DATABASE_URL`. |

## Theme and build

| Symptom | Cause and fix |
|---|---|
| Build fails: "You're importing a module that depends on server-only" | A client component imports `@/config/server` or another server-only module. Pass the value from a server component, or fetch it from the API. |
| `check:bundle` fails | Browser assets mention a server variable or contain a credential-shaped string. The output names the file and rule; remove the reference (often user-visible text or an accidental import). |
| Docker web build: `"/app/public": not found` | `frontend/public/` must exist (it contains `.gitkeep`). |
| Wrong theme flashes | The theme comes from the `lf_theme` cookie and is applied server-side; clear the cookie to return to the default (dark). |
