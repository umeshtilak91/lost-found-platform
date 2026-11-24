# Deployment

## Verification status

| Target | Status |
|---|---|
| Local Docker Compose (`npm run dev`) | **Verified**: builds, migrates, serves on :3000, passes health checks. |
| Isolated compose test stack (`npm run e2e:up`) | **Verified** by the Playwright suite ([test-report.md](test-report.md)). |
| AWS EKS with the Helm chart (below) | **Unverified**: the chart renders and is scanned by Trivy in CI, but has not been deployed to a real cluster from this repository. |

This task did not deploy anywhere.

## Production build (any host)

1. Build the images: `docker build -t lost-found-api backend` and
   `docker build --build-arg API_INTERNAL_URL=http://<api-host>:5000 -t lost-found-web frontend`.
   `API_INTERNAL_URL` is baked into the web image at build time.
2. Configure the API through the host's secret store, never a committed file:
   - `NODE_ENV=production`
   - `APP_URL=https://<host>`
   - `SESSION_SECRET`
   - `DATABASE_URL` + `DB_SSL=true`
   - `PAYMENT_PROVIDER=razorpay` with the `RAZORPAY_*` values
   - `RESEND_API_KEY` + `EMAIL_FROM`
   - optionally `GOOGLE_*` and `GOOGLE_MAPS_API_KEY`

   The API refuses to start if any of these are invalid ([environment-variables.md](environment-variables.md)).
3. Order of operations:
   1. Back up the database.
   2. Run `node server.js migrate` (a one-off job, using the same image and environment).
   3. Roll out the API.
   4. Roll out the web app.
4. HTTPS:
   - Terminate TLS at the proxy or load balancer and route `/api/*` to the API and everything else to the web app, all on one origin.
   - Cookies become `Secure` automatically when `APP_URL` is https.
   - Set `TRUST_PROXY` to the number of proxy hops.
5. Webhooks:
   - In Razorpay (the same mode as the keys), add `https://<host>/api/payments/webhook` with the events `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid` and `refund.processed`.
   - Use the webhook secret as `RAZORPAY_WEBHOOK_SECRET`.
6. OAuth: register `https://<host>/api/auth/google/callback`.
7. Health checks:
   - API liveness `GET /healthz`
   - API readiness `GET /readyz` (503 while the database is down or migrations are pending)
   - Web `GET /healthz`
   - Keep `/metrics` internal.
8. Rollback: deploy the previous images. Migrations are additive, so the
   previous release runs on the newer schema. Never edit an applied migration.

## AWS EKS runbook (unverified)

Nothing in this repository creates AWS resources. Provisioning infrastructure
and deploying to shared environments need separate approval. This document is
the runbook for doing so.

## Target architecture

```
Browser ──HTTPS──> CloudFront (optional) ──> ALB (AWS Load Balancer Controller)
                                              ├─ /api/*  -> Service lost-found-api :5000 -> API pods
                                              └─ /*      -> Service lost-found-web :3000 -> Web pods
API pods ──> RDS PostgreSQL 16 (TLS)     API pods ──IRSA──> S3 (private bucket, SSE)
API pods ──> SMTP (SES)                  API pods ──> Google / Apple OAuth
```

- **One public origin.** The ingress sends `/api` to the API and everything
  else to the web app, so cookies are first-party and no cross-origin requests
  are needed.
- **Images.** Images are never public in S3. The API serves them at
  `/api/images/:id` after checking the listing's visibility. Visible images get
  `Cache-Control: public, max-age=300`; owner-only and moderator-only views get
  `private, no-store`.

## Prerequisites (one-time, needs approval)

| Resource | Notes |
|---|---|
| EKS cluster + AWS Load Balancer Controller | `ingress.className: alb` |
| ECR repositories `lost-found-api`, `lost-found-web` | Turn on scan-on-push and use immutable tags. |
| RDS PostgreSQL 16 | Private subnets, TLS (`DB_SSL=true`), automated backups and PITR, deletion protection. The `pg_trgm` extension must be allowed (it is by default on RDS). |
| S3 bucket | Block all public access, SSE-S3 or SSE-KMS, versioning off (deletes must remove data). Add a lifecycle rule to abort incomplete multipart uploads. |
| IAM role for the API (IRSA) | `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/media/*`, `s3:ListBucket` (for HeadBucket readiness), and `cloudfront:CreateInvalidation` on the distribution. |
| Secret `lost-found-api` in the namespace | Keys: `SESSION_SECRET`, `DATABASE_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY` (or `SMTP_URL`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`, optional `APPLE_*`. Sync it from AWS Secrets Manager with External Secrets Operator. Do not commit it. |
| ACM certificate, optional WAF | Set them in the ingress annotations. |
| GitHub OIDC role for ECR push | `vars.AWS_ECR_PUSH_ROLE_ARN`, `vars.AWS_REGION`, `vars.ECR_API_REPOSITORY`, `vars.ECR_WEB_REPOSITORY`, plus a `release` environment with required reviewers. |

### CloudFront (optional, in front of the ALB)

- **Default behavior.** Use the ALB as origin, with the `CachingDisabled`
  policy and the `AllViewer` origin request policy.
- **`/api/images/*` behavior.**
  - Cache policy: honor origin `Cache-Control` (min TTL 0, default 0, max
    300), with no cookies, headers or query strings in the cache key.
  - Origin request policy: forward the `lf.sid` cookie, so owners and
    moderators still get their private responses. Those responses carry
    `private, no-store`, so they are never cached.
- **Removal.** When a listing or photo is removed, or a moderator takes it
  down, the API purges `/api/images/<id>` and `/api/images/<id>/thumb` if
  `CLOUDFRONT_DISTRIBUTION_ID` is set. Without a purge, cached copies expire
  within 5 minutes.
- **Origin-facing domain.** Let only CloudFront reach the ALB, using a
  custom-header check or the AWS-managed prefix list.

## Release flow

1. CI on `main` or a `v*` tag runs lint, tests, Playwright and Trivy. The
   `publish` job, gated by the `release` environment, then pushes both images
   to ECR tagged with the 12-character git SHA (and the version tag).
2. Deploy staging:
   ```bash
   helm upgrade --install lost-found deploy/helm/lost-found -n lost-found-staging \
     -f deploy/helm/lost-found/values-staging.yaml \
     --set image.registry=<acct>.dkr.ecr.<region>.amazonaws.com \
     --set api.image.tag=<sha> --set web.image.tag=<sha> \
     --set api.serviceAccount.roleArn=<irsa-role-arn> --atomic --timeout 10m
   ```
3. Verify (below), then repeat with `values-production.yaml`.

### Migration order

- The chart runs `node server.js migrate` as a `pre-install,pre-upgrade` hook
  Job **before** any pod is replaced. It applies pending SQL files under a
  PostgreSQL advisory lock and then converts any prototype uploads.
- Migrations are additive. The old version keeps working against the new
  schema, so old pods can serve traffic while new pods roll out.
- If the Job fails, the release fails. With `--atomic`, Helm rolls back, and
  the running Deployments are never touched.
- API pods report not-ready (`/readyz` returns 503) while any migration is
  pending, so a pod can never serve traffic on an older schema than it expects.

### Upgrading the prototype database

The first `migrate` run upgrades a database created by the original
prototype in place. All of these steps are covered by
`backend/test/migrations.test.js`:

- Missing tables are added; the existing hand-made tables and data are kept.
- Phone numbers are normalized to the international format (E.164).
- `google_id` values become sign-in identities.
- Timestamps are converted to time-zone-aware columns.
- Files in the old `uploads/` folder are re-encoded. Anything that isn't an
  image is skipped and never served.

To upgrade it:

1. Take an RDS snapshot.
2. Copy the prototype `uploads/` directory into the location set by
   `LEGACY_UPLOADS_DIR`.
3. Run the migration Job.
4. Check the summary log line, `Legacy image backfill finished`, which reports
   converted, missing and rejected counts.

### Verify after rollout

```bash
kubectl -n <ns> rollout status deploy/lost-found-api deploy/lost-found-web
kubectl -n <ns> logs job/lost-found-migrate-<revision>          # "Database already up to date" / applied list
curl -fsS https://<host>/api/stats                                # 200 JSON
curl -fsS https://<host>/api/auth/providers                       # google/email flags as expected
curl -sI https://<host>/ | grep -i content-security-policy        # headers present
```

Then by hand:

1. Sign in with Google.
2. Post a listing with a photo.
3. Find it in search.
4. Send a message from a second account.
5. Delete the listing.

Watch the dashboards and alerts listed under Monitoring for 30 minutes.

### Rollback

- **Application:** run `helm rollback lost-found <previous-revision> -n <ns>`.
  Because migrations are additive, the previous image runs against the newer
  schema. The pre-upgrade hook does not run on rollback.
- **Failed migration:** the Job's transaction rolls back that file, so nothing
  is half-applied. Fix forward with a new migration file; never edit an
  applied one, because the runner warns on checksum drift.
- **Data corruption (last resort):** restore the RDS snapshot or use
  point-in-time recovery to a new instance, point `DATABASE_URL` at it, and
  redeploy.

## Monitoring

With `monitoring.*.enabled`, the chart creates a ServiceMonitor for `/metrics`
and the following alerts:

| Alert | Fires when |
|---|---|
| `LostFoundApiHighErrorRate` | 5xx responses are above 2% for 10 minutes |
| `LostFoundApiSlow` | p95 latency is above 1.5 s for 15 minutes |
| `LostFoundApiNotReady` | No API pod is ready |
| `LostFoundRateLimiting` | 429 responses keep occurring |

Logs are JSON (pino) with `X-Request-Id` correlation. Cookies, tokens, email
addresses, phone numbers, claim answers and message bodies are redacted or
never logged. Ship the logs to CloudWatch with Fluent Bit and keep them for 30
days. That period is a placeholder until the owner confirms the policy.
