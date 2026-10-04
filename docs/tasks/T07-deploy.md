# T07 — Deploy: separate API and web images for Dokploy

You are implementing task T07 of the Camex Invoice Tracker. Read CLAUDE.md, docs/SPEC.md (§3, §4, §11, §12) and this file before writing code.

## 0. Git

- Precondition: `main` contains T04. `docs/tasks/T07-deploy.md` (CTO-provided) is either untracked or already committed. Anything else uncommitted → stop and ask.
- Create branch `t07-deploy`. Commit this file as part of T07. One commit "T07: deploy + T04 follow-ups". Do not merge or push.

## 0b. T04 follow-ups (CTO decisions on the T04 questions)

Small changes. Each gets a test, and SPEC §8/§9 are updated to match.

1. **Linking when another vendor owns the extracted name:** keep as implemented (link, no alias).
2. **NOT_BILLED_TO_CAMEX:** a bill-to name containing "camex" or "კამექს" (case-insensitive) passes.
3. **Flag order within a severity:** keep SPEC table order.
4. **Vendor email domains also match subdomains:** `mail.aegfuels.com` matches a vendor domain `aegfuels.com`. `OWN_EMAIL_DOMAINS` already works that way.
5. **Evaluate inside the extraction transaction.** The success write and the final-failure write each run `evaluate` in their own transaction, so an invoice is never `needs_review` without flags. If evaluation throws, the extraction write rolls back and the job retries as a normal error. Keep the post-commit `evaluateWithRelated` for duplicate convergence. Remove the "failed evaluation looks clean" known issue.
6. **TOTAL_MATH:** skip when no line item has an amount, as LINE_MATH does.

## 1. Target topology (replaces "one container" in SPEC §3)

Two Dokploy applications, built from this repo. Every domain is configuration; nothing environment-specific goes into an image.

| | Staging | Production |
|---|---|---|
| Web (SPA) | `https://camex-fin.site` | other domain (later) |
| API | `https://api.camex-fin.site` | other domain (later) |
| Inbound mail | `invoices@mg.camex-fin.site` (Mailgun domain `mg.camex-fin.site`) | other domain (later) |

- **Mailgun:** the route forwards to `https://<api host>/api/inbound/mailgun`. The code never depends on the recipient address.
- **TLS:** Traefik (Dokploy) terminates it in front of both apps.

**Same-site rule (put it in SPEC §3 and the runbook):**
- The web and API hosts must share a registrable domain, like `camex-fin.site` and `api.camex-fin.site`.
- The session cookie stays `SameSite=Lax` and host-only on the API host. A same-site `fetch` with credentials carries it; a cross-site one doesn't.
- Production must follow the same pattern, e.g. `invoices.example.com` + `api.invoices.example.com`.
- Don't add a `SameSite=None` mode.

### Hosted services

**Postgres (hosted)**
- Keep the single `DATABASE_URL`; Prisma and pg-boss both take a URL.
- In the runbook, document:
  - URL-encoding special characters in the password;
  - appending `?sslmode=require` when the host requires TLS. Check that pg-boss honours it too, and say how in the report.

**Cloudflare R2 for PDFs**
- Settings: `S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, a private bucket, and an R2 API token scoped to "Object Read & Write" on that one bucket.
- Verify against Cloudflare's current R2 docs for aws-sdk-js-v3, and report what you found:
  1. Whether the installed SDK version needs `requestChecksumCalculation` / `responseChecksumValidation` set to `"WHEN_REQUIRED"` for R2. If so, set it in the S3 client (harmless for MinIO).
  2. The recommended `S3_FORCE_PATH_STYLE` value for R2.
  3. Which call the health check can use with a bucket-scoped token (HeadBucket if allowed, otherwise something that is).
  4. Whether R2 has object versioning. If not, write in the runbook what protects the PDFs instead. Note that the app never deletes objects.

## 2. API changes

- **Stop serving the SPA.** Remove the production static and SPA-fallback serving from T01, along with its tests. Unknown non-`/api` paths → 404.
- **CORS:** `WEB_ORIGINS` (comma-separated exact origins, required in production; e.g. `https://camex-fin.site`). Enable CORS for those origins only:
  - credentials: true;
  - methods GET, POST, PATCH, DELETE;
  - header Content-Type;
  - preflight max-age 600.

  `/api/inbound/*` needs no CORS.
- **Origin check (CSRF defence in depth):** for POST, PATCH and DELETE on `/api/*` except `/api/inbound/*`:
  - an `Origin` header that isn't in `WEB_ORIGINS` → 403;
  - no `Origin` → allowed (curl, scripts).
- **Proxy:** `TRUST_PROXY=1` behind Traefik. Document that login rate limiting depends on it.
- **Health:** `GET /api/health` already checks the DB; also check that the bucket is reachable (the call from the R2 section), with a 2 s timeout.
- **Simulator:** `simulate:mailgun` gets `--url <base>`. The signing key comes from `MAILGUN_WEBHOOK_SIGNING_KEY` in the environment, so it can be run against staging without editing `.env`.

## 3. Web changes

- **Runtime config, not build-time.** The SPA reads `window.__APP_CONFIG__ = { apiBaseUrl, inboxAddress }` from `/config.js`, loaded before the bundle in `index.html`.
  - In dev, `apps/web/public/config.js` sets `apiBaseUrl: ""`, so relative `/api` keeps going through the Vite proxy; `inboxAddress` is null.
  - Never use `VITE_*` variables for anything environment-specific.
- **API calls:** every call goes to `${apiBaseUrl}/api/...` with `credentials: 'include'`. Links that open PDFs use the same base.
- **Inbox address:** when `inboxAddress` is set, show "Vendors send invoices to `<address>`" with a copy button on `/inbox` (header, and the empty state).

## 4. Dockerfiles

Build context is the repo root for both, because of the pnpm workspace. Add a root `.dockerignore` excluding: node_modules, dist, .env*, fixtures/invoices/eval-out, coverage, .git, docs/reports.

### `apps/api/Dockerfile`

- **Base:** multi-stage on `node:24-bookworm-slim`, not alpine, because Prisma engines and argon2 are native.
- **Build:** pnpm via corepack; `pnpm install --frozen-lockfile`; prisma generate; build `packages/shared` and `apps/api`; then `pnpm deploy --filter @camex/api --prod` (or equivalent) so the runtime holds production dependencies only, plus the Prisma schema and migrations.
- **Runtime:**
  - non-root user; `NODE_ENV=production`; port from `PORT` (default 3000);
  - entrypoint runs `prisma migrate deploy`, then starts the server with `exec`, so SIGTERM reaches Node and pg-boss shuts down gracefully;
  - Docker `HEALTHCHECK` calls `/api/health` using `node -e` (no curl in slim).
- **CLIs:** the compiled `create-admin` and `simulate:mailgun` stay in the image, runnable with `node`. Document the exact commands.
- **Size:** report the image size; aim for under 400 MB.

### `apps/web/Dockerfile`

- **Build:** Node stage, `pnpm build` for web.
- **Runtime:** `nginxinc/nginx-unprivileged` (port 8080, non-root).
  - SPA fallback to `index.html`.
  - Cache headers: `/assets/*` (hashed) `public, max-age=31536000, immutable`; `index.html` and `config.js` `no-store`.
  - `/healthz` → 200.
  - Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`.
  - gzip for text assets.
- **`/config.js` at container start** from env `API_BASE_URL` (required, absolute https URL in production) and `INBOX_ADDRESS` (optional). Generate it with a small entrypoint script that JSON-escapes the values (no raw `envsubst` into JS). Fail to start if `API_BASE_URL` is missing.

### Build check

Build both images locally and run them against the dev compose Postgres and MinIO:
- API on host port 3190, web on 8090, `WEB_ORIGINS=http://localhost:8090`, `API_BASE_URL=http://localhost:3190`, `TRUST_PROXY=0`;
- log in through the web container in a browser (`Secure` off because `NODE_ENV` isn't production for this check, or document how you handled it);
- `simulate:mailgun --url http://localhost:3190`, then open a PDF from `/inbox`.

## 5. Runbook: `docs/deploy.md`

Short and step by step, for Otto. Commands and values in code blocks.

1. **Dokploy API app:** repo, branch, build type Dockerfile, Dockerfile path `apps/api/Dockerfile`, context `.`, domain, container port, health check path.
2. **Dokploy web app:** the same with `apps/web/Dockerfile`, port 8080.
3. **Env tables:** every variable for the API (from `env.ts`: name, required?, staging example, notes) and for web.
   - Mark secrets.
   - Staging values use the hosts in §1.
   - `OWN_EMAIL_DOMAINS` includes `camex.aero,camex-fin.site`.
   - Storage: R2 values for staging, as found in §1.
   - `DATABASE_URL`: the hosted Postgres URL, with the encoding and TLS notes from §1.
4. **Mailgun:** a route with `match_recipient("invoices@mg.camex-fin.site")` → `forward("https://api.camex-fin.site/api/inbound/mailgun")` → `stop()`; where to find the HTTP webhook signing key.
5. **First boot:** set `BOOTSTRAP_ADMIN_*`, deploy, log in, change the password, then remove the variables and redeploy.
6. **Smoke test:**
   - `curl https://api.camex-fin.site/api/health`;
   - `simulate:mailgun --url https://api.camex-fin.site` with the staging signing key;
   - then a real email with a PDF to the inbound address, checked on `/inbox`.
7. **Backups checklist:** daily backups from the Postgres host; R2 protection as found in §1; a restore drill noted as a to-do.
8. **Production later:** new hosts and the same-site rule; a new Mailgun domain and route; a new signing key; a separate database and bucket.

## 6. SPEC edits

- §3: two applications (API, web), runtime web config, the same-site rule.
- §4: inbound domain is configuration (staging `mg.camex-fin.site`); replace the camex.aero forwarding note with "a Mailgun domain per environment; the address is shown in the UI from `INBOX_ADDRESS`".
- §11: CORS (`WEB_ORIGINS`) and the Origin check.
- §12: health checks, migrations on start, the runbook link.
- §13: T07 row = "Dockerfiles + Dokploy runbook; staging live".

## Tests

- **CORS:** an allowed origin gets the credentialed CORS headers; another origin gets none; preflight works.
- **Origin check:** a POST with a foreign Origin → 403; allowed or absent Origin → normal; the webhook is unaffected.
- **No SPA serving:** `GET /` and `GET /inbox` on the API → 404.
- **Health:** fails (503) when the bucket is unreachable.
- **Web config:** a unit test for the config.js generator (escaping, missing `API_BASE_URL` fails).
- **Images:** both build; the build check in §4 passes (describe what you ran and what you saw).

## Out of scope

Dokploy API automation, CI pipelines, production hosts, CSP (revisit in T06 with the PDF viewer).

## Done when

- Both images build and run locally as in §4.
- `docs/deploy.md` is complete enough that Otto can create both Dokploy apps and the Mailgun route without asking.

## Report

`docs/reports/T07-deploy.md` with the sections from CLAUDE.md, image sizes, and `git diff --stat main...HEAD`. Don't claim anything works unless you ran it.
