# T07 — Deploy: separate API and web images for Dokploy (+ T04 follow-ups)

Branch `t07-deploy`, one commit "T07: deploy + T04 follow-ups". Not merged, not pushed.

## 1. Summary

- **Two images, built from the repo root:**
  - `apps/api/Dockerfile`: the API with its job workers. It runs `prisma migrate deploy`, then `exec node`.
  - `apps/web/Dockerfile`: the SPA on `nginx-unprivileged`. It writes `/config.js` from `API_BASE_URL` and `INBOX_ADDRESS` at container start.
- **The API no longer serves the SPA.** It has `WEB_ORIGINS`-based CORS, an Origin check for state-changing requests, and a health check that also probes the bucket (2 s timeout).
- **The SPA reads its API URL at runtime** (`window.__APP_CONFIG__`). It calls the API with `credentials: 'include'` and shows the inbound address with a copy button on `/inbox`.
- **Runbook:** [`docs/deploy.md`](../deploy.md). It covers both Dokploy apps, every env variable, Mailgun, first boot, smoke test, backups and production later.
- **The six T04 follow-ups are done**, with tests, and SPEC §8/§9 updated.
- **Verified locally:**
  - Both images build: API **457 MB**, web **55 MB**.
  - Ran together against the dev compose Postgres and MinIO in production mode, a headless browser logged in through the web container and opened a PDF from `/inbox` after `simulate:mailgun --url http://localhost:3190`.
  - `pnpm test`: 284 API tests + 6 web tests pass. Lint and typecheck are clean.
- **Not done by me:** a real staging deploy (Dokploy, R2, Mailgun, hosted Postgres). I have no access, so "staging live" is still open.
- **Below the 400 MB aim:** no. The API image is 457 MB, mostly because of the Prisma CLI needed for migrations on start (§3, Q1).

## 2. What was built

### T04 follow-ups (§0b)

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                          | Test                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Linking when another vendor owns the name: kept (link, no alias). SPEC §9 now says so.                                                                                                                                                                                                                                                                                                                                          | existing `vendors.e2e` "corrects a wrong match: the extracted name stays with the vendor that owns it"                                                                                                          |
| 2   | `NOT_BILLED_TO_CAMEX` passes for "camex" or "კამექს" (case-insensitive, so Georgian capitals "ᲙᲐᲛᲔᲥᲡ" pass too).                                                                                                                                                                                                                                                                                                                | `flags.test` NOT_BILLED_TO_CAMEX: Mkhedruli, Mtavruli, and a non-Camex Georgian name                                                                                                                            |
| 3   | Flag order within a severity: kept (SPEC table order).                                                                                                                                                                                                                                                                                                                                                                          | existing `flags.test` ordering test and the fixture tests (BANK_FIRST_SEEN before DISPUTE_SOON)                                                                                                                 |
| 4   | Vendor email domains match subdomains (`mail.aegfuels.com` → `aegfuels.com`). When two vendors' domains both match, the most specific wins. `fakeaegfuels.com` doesn't match (whole labels only).                                                                                                                                                                                                                               | `evaluation.e2e` "a subdomain of a vendor domain matches too; the most specific vendor domain wins"                                                                                                             |
| 5   | The success write and the final-failure write each run `evaluate` inside their own transaction. If evaluation throws, the write rolls back and the job fails as a normal (retryable) error. The post-commit `evaluateWithRelated` stays for duplicate convergence. The recovery sweep's give-up uses the same path and now catches per invoice. The "failed evaluation looks clean" known issue is removed from the T04 report. | `evaluation.e2e` › "evaluation inside the extraction transaction" (4 tests: flags present without the post-commit pass; rollback on success; rollback on final failure; sweep continues past a failing invoice) |
| 6   | TOTAL_MATH is skipped when no line item has an amount (like LINE_MATH).                                                                                                                                                                                                                                                                                                                                                         | `flags.test` "is skipped when no line item has an amount"                                                                                                                                                       |

Code: `apps/api/src/evaluation/{flags,email-domains,invoice-evaluator}.ts`, `apps/api/src/extraction/{extraction.handler,extraction-failure,recovery-sweep}.ts`.

### API (§2)

- **SPA serving removed.** `spa.ts`, `WEB_DIST_DIR` and `@nestjs/serve-static` are gone. Non-`/api` paths are 404 (`production.e2e`).
- **`WEB_ORIGINS`** (`config/env.ts`):
  - comma-separated exact origins, validated as `scheme://host[:port]` with no path or slash;
  - required when `NODE_ENV=production`;
  - outside production it defaults to `http://localhost:5180` (the Vite dev server, whose proxy forwards the browser's Origin).
- **CORS** (`app.setup.ts`, Nest's `enableCors` with a per-request delegate):
  - Allowed origins get `Access-Control-Allow-Origin: <origin>`, `-Credentials: true`, `-Methods: GET,POST,PATCH,DELETE`, `-Headers: Content-Type`, and `-Max-Age: 600` on preflight.
  - Other origins, and every `/api/inbound/*` request, get no CORS headers at all.
- **Origin check** (`app.setup.ts`): an Express middleware registered before cookie and body parsing.
  - POST, PATCH, DELETE (any non-GET/HEAD/OPTIONS) with an `Origin` outside `WEB_ORIGINS` → `403 {"statusCode":403,"error":"Forbidden","message":"Origin not allowed"}`.
  - No `Origin` → passes.
  - `/api/inbound/*` is exempt, matched case-insensitively because Express routes are.
- **Health** (`health/health.controller.ts`, `storage/storage.service.ts`): `GET /api/health` → `{"status","db","storage"}`, 200 or 503.
  - Storage probe: `ListObjectsV2` (`MaxKeys: 1`), aborted after 2 s.
- **S3 client**: `requestChecksumCalculation` / `responseChecksumValidation` set to `WHEN_REQUIRED` (§3, R2 findings).
- **`TRUST_PROXY`** is unchanged in code. Its role in login rate limiting is documented in the runbook, SPEC §11 and `.env.example`.
- **Simulator**: `simulate:mailgun --url <base>` posts to `<base>/api/inbound/mailgun`. The signing key comes from `MAILGUN_WEBHOOK_SIGNING_KEY` in the environment, falling back to the root `.env` (environment wins, as before). The target URL is printed first.

### Web (§3)

- `apps/web/src/lib/config.ts` reads `window.__APP_CONFIG__` with a zod check and exports `apiUrl(path)`.
- `index.html` loads `/config.js` before the bundle.
- `apps/web/public/config.js` is the dev version (`apiBaseUrl: ""`, `inboxAddress: null`).
- No `VITE_*` variables.
- `lib/api.ts`: every call goes to `apiUrl(path)` with `credentials: 'include'`.
- `invoice-chip.tsx`: "Open PDF" uses `apiUrl`.
- `/inbox`: when `inboxAddress` is set, the header and the empty state show "Vendors send invoices to `<address>`" with a copy button (`pages/inbox/inbox-address.tsx`).
- The hard-coded `invoices@camex.aero` texts on `/inbox` and the `/invoices` placeholder are gone.

### Images (§4)

- **`.dockerignore`**: `**/node_modules`, `**/dist`, `**/coverage`, `**/.env*`, `**/*.tsbuildinfo`, `.git`, `.remember`, `docs/reports`, `fixtures/invoices/eval-out`, `apps/api/src/generated`.
- **`apps/api/Dockerfile`**:
  - `node:24-bookworm-slim` with `openssl` and `ca-certificates` (Prisma's schema engine links OpenSSL and uses the system CAs for TLS).
  - Build stage: corepack pnpm, `pnpm fetch` (cached on the lockfile), `install --offline --frozen-lockfile`, shared build, `prisma generate`, API build, `pnpm deploy --prod /out`, then a prune step (§3).
  - Runtime: user `node`, `NODE_ENV=production`, `PORT=3000`, layout `/app/apps/api` (mirrors the repo, so the CLIs find `/app/fixtures/invoices`).
  - `docker-entrypoint.sh` runs `prisma migrate deploy`, then `exec node dist/main.js`.
  - `HEALTHCHECK` uses `node -e "fetch(.../api/health)"`.
- **`apps/web/Dockerfile`**: a Node build stage (`install --filter '@camex/web...' --ignore-scripts`, shared build, web build), then `nginxinc/nginx-unprivileged:1.30-alpine`.
  - `docker/default.conf`:
    - port 8080, SPA fallback;
    - `/assets/` immutable for a year, and a 404 when missing;
    - `index.html` and `config.js` `no-store`;
    - `/healthz` 200;
    - gzip;
    - the three security headers in every location (`docker/security-headers.conf`);
    - `server_tokens off`.
  - `docker/40-app-config.sh` runs from the image's `/docker-entrypoint.d/`.
    - It JSON-escapes the values (backslash and quote) and refuses control characters.
    - It requires `API_BASE_URL` to be `https://` (`http://` only for localhost) and strips trailing slashes.
    - It fails, and so stops the container, without `API_BASE_URL`.
    - Only `config.js` is writable by the nginx user.
  - `HEALTHCHECK` uses busybox `wget` on `/healthz`.
- **Package changes:**
  - `prisma` moved from devDependencies to dependencies (the entrypoint runs it).
  - `@nestjs/serve-static` removed.
  - `"files"` added to `apps/api` and `packages/shared` so `pnpm deploy` copies only `dist`, `prisma` and `prisma.config.ts` (without it, deploy copied `src`, `test` and a local `.env`).
  - No new dependencies.

### Docs (§5, §6)

- `docs/deploy.md`: the runbook.
- SPEC:
  - §3: two apps, runtime web config, same-site rule.
  - §4: Mailgun domain per environment, address from `INBOX_ADDRESS`.
  - §8: evaluation inside the extraction transaction, TOTAL_MATH, NOT_BILLED_TO_CAMEX.
  - §9: subdomains, link without alias.
  - §11: host-only cookie, CORS, Origin check, `TRUST_PROXY`.
  - §12: health, migrations on start, backups/bucket lock, runbook link.
  - §13: T07 row.
- README: "Deployment" section, `simulate:mailgun --url`, the `pnpm build` row no longer claims the API serves the SPA.
- `.env.example`: `WEB_ORIGINS`, R2 hints, `WEB_DIST_DIR` removed.

## 3. Deviations (with reasons)

- **API image is 457 MB, not under 400 MB.**
  - Breakdown: about 259 MB is `node:24-bookworm-slim` plus `openssl`/`ca-certificates`; about 198 MB is the app and its production dependencies.
  - The Prisma CLI that `prisma migrate deploy` needs is about 130 MB of that: `@prisma/studio-core` 43, `prisma` 41, `@prisma/engines` 23, `@prisma/dev` 19, `effect` 18. The CLI `require`s `@prisma/studio-core` and `@prisma/dev` at startup; I checked this by deleting them, after which `prisma --version` fails with `Cannot find module '@prisma/studio-core/data/bff'`.
  - Without the prune step the image was **659 MB**. The prune removes what nothing loads:
    - the optional peers `typescript`, `react` and `react-dom`;
    - `@electric-sql/pglite` (only `prisma dev`) and `elkjs` (Studio);
    - the MySQL, SQLite, SQL Server and CockroachDB query-compiler wasm;
    - `.d.ts` and `.map` files.
  - I verified migrations (`migrate status`/`migrate deploy`) and the app after pruning. Options are in Q1.
- **SPEC §12 "bucket versioning"** is now "bucket lock rules", because R2 has no object versioning (§1 finding 4).
- **SPEC §13 T07 row.** I read "Dockerfiles + Dokploy runbook; staging live" as the two columns: Task "Deploy: Dockerfiles + Dokploy runbook", Done when "staging live".

## 4. Decisions not in the spec

- **The Origin check covers every non-GET/HEAD/OPTIONS method** (so PUT too, though there are no PUT routes), on every path except `/api/inbound/*`. Every route is under `/api`, so this matches the spec in practice and leaves no bypass through odd methods or paths.
- **Disallowed origins get no CORS headers at all.** A static origin list would still send `Access-Control-Allow-Credentials: true` to them, so I used a per-request delegate. That satisfies "another origin gets none" literally.
- **`WEB_ORIGINS` default outside production** is `http://localhost:5180`, so `pnpm dev` keeps working without `.env` changes. Verified: a login POST through the Vite proxy reaches the handler, and a foreign Origin gets 403.
- **Health response** is `{status, db, storage}`. The storage probe is `ListObjectsV2` because a bucket-scoped R2 token has object permissions only (§R2 findings). The DB probe keeps no timeout, as before.
- **R2 checksums: `WHEN_REQUIRED`.** Cloudflare's docs no longer ask for it, but their compatibility table still lists full-object CRC32 as unsupported, and I couldn't test against R2. It's harmless for MinIO. The trade-off is losing the SDK's end-to-end CRC on uploads; TLS still covers transport. See Q3.
- **The fixture PDFs ship in the API image** (`/app/fixtures/invoices`, about 0.5 MB), so `node dist/cli/simulate-mailgun.js` works inside the container with no `--file`.
- **The API image keeps the repo layout** (`/app/apps/api`), so code that resolves paths relative to itself keeps working: the CLIs' fixtures path, and the root `.env` lookup, which finds nothing.
- **`config.js` generator:**
  - `https://` only, except `http://localhost` / `127.0.0.1` (for the local check);
  - trailing slashes stripped;
  - control characters refused;
  - an empty `INBOX_ADDRESS` means null.
- **nginx:** IPv4 `listen 8080` only, a missing `/assets/*` file is a 404 rather than `index.html`, and the web image has a `HEALTHCHECK` too.
- **Web unit test** uses Node's built-in runner (`node --test`), so no new dependency. `pnpm test` now runs it.
- **Subdomain matching: the most specific vendor domain wins.** Domains stay exactly-unique across vendors, so `aegfuels.com` and `billing.aegfuels.com` can belong to two vendors.
- **The recovery sweep** catches errors per invoice, so one invoice whose evaluation keeps failing can't block the others. Nothing is written for it, and the next sweep retries.
- **A non-retryable failure whose evaluation then throws** (follow-up 5) propagates, so pg-boss retries the job and the extractor runs again. That's the "normal error" path the CTO described.
- **DNS:** the runbook recommends Cloudflare **DNS only** (grey cloud). Behind Cloudflare's proxy, Traefik drops Cloudflare's `X-Forwarded-For`, because Dokploy's Traefik doesn't trust it, and the login rate limit would see Cloudflare IPs.

## 5. Findings the task asked for

### R2 with `@aws-sdk/client-s3` 3.1145.0

These come from Cloudflare's docs, read on 2026-10-04 by a research subagent, plus the installed SDK source.

1. **Checksums.**
   - The current example (developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/, updated 2026-04-21) creates `new S3Client({ region: "auto", endpoint, credentials })` with **no** checksum settings, and no R2 page mentions `WHEN_REQUIRED` any more.
   - The January 2025 CRC32 incident was resolved on 2025-02-03 (cloudflarestatus.com/incidents/t5nrjmpxc1cj).
   - The S3 compatibility page lists CRC32 as ✅ composite / ❌ full-object; only CRC64NVME is full-object.
   - The installed SDK still defaults to `WHEN_SUPPORTED`.
   - **Conclusion:** not documented as required, and possibly needed. I set it as a precaution (§4, Q3). It can't be verified without an R2 account; the staging smoke test (a real upload plus Open PDF) is the check.
2. **Path style:** R2 supports both, and Cloudflare's JS examples use virtual-hosted style, so **`S3_FORCE_PATH_STYLE=false`**. Region: "`auto`" (an empty value and `us-east-1` alias to it).
3. **Health call:** the token docs say an **Object Read & Write** token can "read, write, and list objects in specific buckets"; bucket operations are Admin-only. The docs are silent on HeadBucket, and one 2026 report saw it fail (HTTP 400) with such a token. So the probe is **ListObjectsV2** (`MaxKeys: 1`).
4. **Versioning:** R2 doesn't implement `PutBucketVersioning` or Object Lock.
   - **Bucket lock rules** (developers.cloudflare.com/r2/buckets/bucket-locks/) prevent deletion and overwrite for N days, until a date, or indefinitely. You set them in the dashboard (bucket → Settings → Bucket lock rules) or with `wrangler r2 bucket lock add … --retention-indefinite`, using an admin token; the app's token can't.
   - A locked bucket can't be emptied.
   - The app never deletes objects and never overwrites one (one `put` per invoice under `invoices/<yyyy>/<mm>/<invoice id>.pdf`). The runbook §7 has the checklist.

### Postgres TLS (`sslmode`), and whether pg-boss honours it

I ran the API image against a throwaway `postgres:16-alpine` with `ssl=on` and a self-signed certificate (container `camex-t07-pgtls`, port 56433, removed afterwards). For each `DATABASE_URL` variant I recorded the container state, the migration result, and `pg_stat_ssl` for the app's connections:

| URL params                            | `prisma migrate deploy`                                                       | App (Prisma Client via adapter-pg + pg-boss)                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sslmode=require`                     | applied all 3 migrations (certificate **not** verified)                       | exited 1: `Error: self-signed certificate` (node-postgres treats `require` as verify-full and prints its SECURITY WARNING) |
| `sslmode=require&sslaccept=strict`    | `P1011 … certificate verify failed (self-signed certificate)`                 | not reached                                                                                                                |
| `sslmode=require&uselibpqcompat=true` | OK                                                                            | healthy; 5 connections, all `ssl = t`, TLSv1.3                                                                             |
| `sslmode=no-verify`                   | OK (Prisma doesn't know `no-verify` and uses `prefer`, per the engine source) | healthy, TLS                                                                                                               |
| (none)                                | OK (`prefer`)                                                                 | healthy but **plaintext** (`ssl = f`)                                                                                      |

- **pg-boss honours `sslmode` from the URL.** Grouping `pg_stat_ssl` by `application_name` for the `uselibpqcompat` run gave `camex-jobs` (pg-boss) 4 connections and Prisma Client 1, all TLSv1.3. Both build a `pg.Pool` from `connectionString`, and pg-connection-string's URL settings apply.
- **Runbook default:** `?sslmode=require&uselibpqcompat=true`, which is encrypted, unverified and consistent everywhere (libpq's `require`).
- **Stricter option:** `?sslmode=require&sslaccept=strict` when the provider's certificate is publicly trusted. With a self-signed certificate both sides refused, which shows both verify. I couldn't test the success case with a publicly trusted certificate locally.
- **Encoding:** the runbook shows how to URL-encode the password without leaving it in shell history.

## 6. How to verify (from a clean clone)

```sh
git clone <repo> t07 && cd t07 && git checkout t07-deploy
cp .env.example .env          # local placeholders; MinIO/Postgres on the compose ports
pnpm install
docker compose up -d --wait
pnpm lint && pnpm typecheck && pnpm test     # expect: lint clean; API 284 tests + web 6 tests pass

docker build -f apps/api/Dockerfile -t camex-api .
docker build -f apps/web/Dockerfile -t camex-web .
docker image ls camex-api camex-web          # ~457 MB / ~55 MB
```

Local run (the §4 build check). The values are dev placeholders. The API reaches the compose services through `host.docker.internal`:

```sh
docker compose exec -T postgres createdb -U camex camex_check
docker run -d --name api -p 3190:3000 \
  -e DATABASE_URL=postgresql://camex:camex@host.docker.internal:55432/camex_check \
  -e S3_ENDPOINT=http://host.docker.internal:59000 -e S3_BUCKET=camex-invoices \
  -e S3_ACCESS_KEY_ID=camex-dev -e S3_SECRET_ACCESS_KEY=camex-dev-secret -e S3_FORCE_PATH_STYLE=true \
  -e WEB_ORIGINS=http://localhost:8090 -e TRUST_PROXY=0 -e MAILGUN_WEBHOOK_SIGNING_KEY=local-check \
  -e EXTRACTOR_PROVIDER=stub -e BOOTSTRAP_ADMIN_EMAIL=admin@camex.aero -e BOOTSTRAP_ADMIN_PASSWORD=first-boot-password \
  camex-api
docker run -d --name web -p 8090:8080 -e API_BASE_URL=http://localhost:3190 -e INBOX_ADDRESS=invoices@mg.camex-fin.site camex-web
curl -s localhost:3190/api/health                       # {"status":"ok","db":"ok","storage":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3190/inbox   # 404
MAILGUN_WEBHOOK_SIGNING_KEY=local-check pnpm simulate:mailgun --url http://localhost:3190   # three 200s
```

Then open http://localhost:8090 in Chrome. Log in as `admin@camex.aero` and set a new password. On `/inbox`, the address with its copy button is shown and the three emails are listed; **Open PDF** opens the PDF from `localhost:3190`. The cookie is `Secure` (production), and Chrome accepts that on `http://localhost`. Clean up with `docker rm -f api web` and `docker compose exec -T postgres dropdb -U camex camex_check`.

## 7. Test results

**`pnpm test`** (dev compose stack up):

```
apps/web test: ℹ tests 6  ℹ pass 6  ℹ fail 0
apps/api test:  Test Files  25 passed (25)
apps/api test:       Tests  284 passed (284)
```

- **New API tests:**
  - `cors.e2e` (9): allowed origins get credentialed headers; a foreign origin gets none; preflight 204 with methods, header and max-age; a foreign preflight gets none; inbound gets none; foreign Origin → 403 on POST, PATCH and DELETE, also `null` and mixed-case paths, with no Set-Cookie; allowed or absent Origin passes; GET isn't blocked; the webhook is unaffected.
  - `health.e2e` (4): 200; 503 for a missing bucket; 503 for a refused connection; 503 for a hanging endpoint within 2–3.5 s.
  - `production.e2e`, rewritten: `/`, `/inbox`, deep links and `/assets/*` are 404; the cookie is Secure, HttpOnly, Lax and host-only.
  - `env.test`: `WEB_ORIGINS` parsing, the dev default, required in production, and 6 rejected forms.
  - The T04 follow-up tests in §2.
- **Updated:** `guard.e2e`, whose health body now includes `storage`.
- **Web:** `apps/web/docker/app-config.test.ts` (6) runs the real generator with `sh`:
  - values written and slashes stripped;
  - null address;
  - escaping of quotes, backslashes, `</script>`, `$(…)` and non-ASCII, evaluated in a vm: the values round-trip and no code runs;
  - missing `API_BASE_URL` fails and writes nothing;
  - non-https URLs refused;
  - control characters refused.

  I also ran the generator under the image's busybox `sh` with a tricky `INBOX_ADDRESS`; the output was correctly escaped.

**`pnpm lint`** (ESLint + Prettier): clean. **`pnpm typecheck`**: clean in all three workspaces.

**Build check (§4), run on 2026-10-04** with images built from this tree. The API and web ran as above against the dev compose Postgres and MinIO, using a scratch database `camex_t07_check` and a scratch bucket `camex-t07-check`, both removed afterwards. Settings: `NODE_ENV=production` (the image default), `TRUST_PROXY=0`, stub extractor, a bootstrap admin.

- **API start:** the log showed `Applying migration …` ×3 and `All migrations have been successfully applied`, then `bootstrap admin created: check-admin@camex.aero`. Docker health went to `healthy`.
- **API HTTP:** `GET /api/health` → `{"status":"ok","db":"ok","storage":"ok"}`. `GET /` → 404 and `GET /inbox` → 404.
- **Web, with curl:**
  - `/config.js` contains the generated JSON with `Cache-Control: no-store`;
  - `/inbox` returns `index.html` (`no-store`);
  - a hashed asset gets `public, max-age=31536000, immutable` and `Content-Encoding: gzip`;
  - `/assets/missing.js` → 404;
  - `/healthz` → `ok`;
  - `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` are present.
- **Browser** (headless Chromium via a Playwright script, outside the repo):
  - `/inbox` redirects to `/login`. The bootstrap admin logs in, is asked to set a password, sets it, and lands on `/inbox`.
  - API cookie: `camex_session`, domain `localhost` (host-only), `httpOnly`, `secure`, `sameSite: Lax`. Every API call went to `http://localhost:3190`.
  - The address appears twice (header and empty state). The copy button put `invoices@mg.camex-fin.site` on the clipboard.
  - `pnpm simulate:mailgun --url http://localhost:3190` (key from the environment) → `POST http://localhost:3190/api/inbound/mailgun` and three `200`s.
  - After reload, 3 "Open PDF" links. Clicking one opened a new tab: `http://localhost:3190/api/invoices/<id>/file` → `200 application/pdf`, `inline; filename="aeg.pdf"`. The same URL without a session → 401.
  - Console: only the expected 401 from `/api/auth/me` before login.
- **CLIs in the container:**
  - `node dist/cli/simulate-mailgun.js` (fixtures, `localhost:$PORT` and the key from the env) → three 200s;
  - `--bad-signature` → 401;
  - `node dist/cli/create-admin.js --email … --name … --password …` → "Created admin …".
- **Shutdown:** Node is PID 1 (`node dist/main.js`). `docker stop` returned in under 1 s with exit code **0** rather than a 10 s wait and SIGKILL (137). So SIGTERM reached Node and Nest's shutdown hooks ran, including `boss.stop({ graceful: true })`. The app doesn't log its shutdown, so that is the evidence.
- **Failure modes:**
  - web without `API_BASE_URL` → exit 1 with `app-config: API_BASE_URL is required …`;
  - web with `http://api.camex-fin.site` → refused;
  - API in production without `WEB_ORIGINS` → exit 1 with `WEB_ORIGINS: required in production …`.
- **Dev mode:** `pnpm dev`, then a login POST through the Vite proxy with `Origin: http://localhost:5180` → 401 "Invalid email or password" (it reached the handler). A foreign Origin → 403.

**Clean clone (commit `03cd28f`: the same code as the final commit, whose amends only added these results to this report)**, in a scratch directory with compose project `camex-invoices-check` (ports 56432/60000/60001; torn down with `down -v` afterwards):

- `pnpm install --frozen-lockfile`, `pnpm lint` and `pnpm typecheck` were clean.
- `pnpm test` → web 6/6, API **25 files, 284 tests passed**.
- Both images built from the clone (457 MB / 55 MB). The clone has a `.env`, and the API image contains no `.env*` file, so `.dockerignore` works.
- I ran the clone-built images against the check project's fresh database: `All migrations have been successfully applied`, `bootstrap admin created`, health `ok`. The same browser script then gave the same results as above: login and password change, `Secure`/`Lax` host-only cookie, address and copy, `simulate:mailgun --url` three 200s, Open PDF `200 application/pdf`, 401 without a session.

Afterwards I removed the scratch database `camex_t07_check` and bucket `camex-t07-check` from the dev stack, and the throwaway containers. The dev database, the dev bucket and the test bucket weren't touched, apart from the build check reading the dev MinIO and Postgres servers.

## 8. Known issues / shortcuts

- **Not deployed.** I have no access to Dokploy, R2, Mailgun or the hosted Postgres. The runbook steps for those services come from their current docs (and Dokploy v0.30.8's source, for the field names), not from doing them. "Staging live" and "real email processed" are Otto's run of runbook §5–§6.
- **API image 457 MB** (§3). The prune step depends on Prisma's internals. Every start runs `migrate deploy`, so if a Prisma upgrade needs something pruned, the container fails at boot instead of misbehaving.
- **`pnpm deploy` (pnpm 9.8) noise.** It re-runs the workspace's root postinstall and warns `Failed to create bin … vite/prettier/esbuild` for root devDependencies. The output is correct: only `dist`, `prisma`, `prisma.config.ts` and production `node_modules`.
- **The Mailgun signing-key location** in the dashboard is from third-party pages; Mailgun's docs don't give the menu path. The runbook names both places it has been. The key is account-wide (Q2).
- **Migrations during zero-downtime deploys.** Dokploy starts the new container first, so migrations must stay compatible with the running version. This is in the runbook.
- **The login rate limiter is in memory per container.** During a start-first deploy two containers briefly have separate counters. That's negligible.
- **nginx logs one info line at start:** `10-listen-on-ipv6-by-default.sh: can not modify /etc/nginx/conf.d/default.conf`. Our config is read-only on purpose and listens on IPv4 only.
- **Pre-existing, seen in the build check:** at 1280 px the Inbox table with three emails is wider than its container, and the "Ignored attachments" column is clipped. T07 didn't touch the table rows. Flagged for T05/T06.
- **`create-admin --help` in the image** still prints `pnpm create-admin …`. The runbook gives the `node dist/cli/create-admin.js` form.
- **The T04 report's "brief flagless window" item is also resolved** by follow-up 5 (the `needs_review` row commits with its flags). I removed only the item the CTO named.

## 9. Questions for the CTO

1. **API image size.** 457 MB against the 400 MB aim; about 130 MB is the Prisma CLI for migrations on start. Accept it? Or run migrations from a separate one-off image or Dokploy job, so the API image drops the CLI (roughly 330 MB, but then the entrypoint wouldn't migrate)?
2. **Mailgun signing key for production.** It is per Mailgun account, not per domain. Is a "new signing key" for production worth a separate Mailgun account or subaccount, or is the shared key fine?
3. **R2 checksums.** Keep `WHEN_REQUIRED` as a precaution, or try the SDK default on staging first? Cloudflare's docs no longer require it.
4. **Postgres TLS default.** `sslmode=require&uselibpqcompat=true` encrypts without verifying the certificate. Which provider is it? If its certificate is publicly trusted, I'd switch the runbook default to the verified `sslmode=require&sslaccept=strict`.
5. **R2 bucket lock on staging.** Indefinite, or a number of days so staging can still be wiped?

## 10. `git diff --stat main...HEAD`

```
 .dockerignore                                 |  13 +
 .env.example                                  |  20 +-
 README.md                                     |  34 ++-
 apps/api/Dockerfile                           |  63 +++++
 apps/api/docker-entrypoint.sh                 |   8 +
 apps/api/package.json                         |   8 +-
 apps/api/src/app.module.ts                    |   2 -
 apps/api/src/app.setup.ts                     |  53 +++-
 apps/api/src/cli/simulate-mailgun.ts          |  33 ++-
 apps/api/src/config/env.ts                    |  89 +++++--
 apps/api/src/evaluation/email-domains.ts      |  27 +-
 apps/api/src/evaluation/flags.ts              |   9 +-
 apps/api/src/evaluation/invoice-evaluator.ts  |   8 +-
 apps/api/src/extraction/extraction-failure.ts |   9 +-
 apps/api/src/extraction/extraction.handler.ts |  16 +-
 apps/api/src/extraction/recovery-sweep.ts     |  25 +-
 apps/api/src/health/health.controller.ts      |  45 +++-
 apps/api/src/spa.ts                           |  35 ---
 apps/api/src/storage/storage.service.ts       |  27 +-
 apps/api/test/cors.e2e.test.ts                | 180 +++++++++++++
 apps/api/test/env.test.ts                     |  34 +++
 apps/api/test/evaluation.e2e.test.ts          | 121 +++++++++
 apps/api/test/flags.test.ts                   |  23 +-
 apps/api/test/guard.e2e.test.ts               |   2 +-
 apps/api/test/health.e2e.test.ts              |  68 +++++
 apps/api/test/helpers.ts                      |   4 +-
 apps/api/test/production.e2e.test.ts          |  32 +--
 apps/web/Dockerfile                           |  39 +++
 apps/web/docker/40-app-config.sh              |  49 ++++
 apps/web/docker/app-config.test.ts            | 125 +++++++++
 apps/web/docker/default.conf                  |  44 ++++
 apps/web/docker/security-headers.conf         |   5 +
 apps/web/index.html                           |   2 +
 apps/web/package.json                         |   3 +-
 apps/web/public/config.js                     |   4 +
 apps/web/src/lib/api.ts                       |   6 +-
 apps/web/src/lib/config.ts                    |  38 +++
 apps/web/src/pages/inbox/inbox-address.tsx    |  49 ++++
 apps/web/src/pages/inbox/inbox-page.tsx       |  27 +-
 apps/web/src/pages/inbox/invoice-chip.tsx     |   3 +-
 apps/web/src/router.tsx                       |   2 +-
 apps/web/tsconfig.json                        |   2 +-
 docs/SPEC.md                                  |  30 ++-
 docs/deploy.md                                | 224 ++++++++++++++++
 docs/reports/T04-validation-vendors.md        |   1 -
 docs/reports/T07-deploy.md                    | 357 ++++++++++++++++++++++++++
 docs/tasks/T07-deploy.md                      | 163 ++++++++++++
 eslint.config.js                              |   5 +
 packages/shared/package.json                  |   3 +
 pnpm-lock.yaml                                |  34 +--
 50 files changed, 1999 insertions(+), 204 deletions(-)
```
