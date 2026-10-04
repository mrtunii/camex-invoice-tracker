# Deploy runbook (Dokploy)

Two Dokploy applications built from this repo, plus a hosted Postgres, a Cloudflare R2 bucket and a Mailgun domain. Traefik (Dokploy) terminates TLS in front of both apps. Nothing environment-specific is built into an image: everything below is runtime configuration.

|              | Staging                                                           | Production (later, §8) |
| ------------ | ----------------------------------------------------------------- | ---------------------- |
| Web (SPA)    | `https://camex-fin.site`                                          | another domain         |
| API          | `https://api.camex-fin.site`                                      | another domain         |
| Inbound mail | `invoices@mg.camex-fin.site` (Mailgun domain `mg.camex-fin.site`) | another domain         |

**Same-site rule.** The web and API hosts must share a registrable domain (`camex-fin.site` and `api.camex-fin.site`). The session cookie is `SameSite=Lax` and host-only on the API host, so the browser sends it on the SPA's `fetch` calls only because the two hosts are same-site. Production must follow the same pattern, e.g. `invoices.example.com` + `api.invoices.example.com`. There is no `SameSite=None` mode.

## 0. Before you start

**DNS** for `camex-fin.site` (A records to the Dokploy server's IP):

```
camex-fin.site        A   <dokploy server IP>
api.camex-fin.site    A   <dokploy server IP>
```

If the zone is on Cloudflare, keep both records **DNS only** (grey cloud). Traefik then gets the Let's Encrypt certificates itself, and `TRUST_PROXY=1` is correct. Behind Cloudflare's proxy, Traefik drops Cloudflare's `X-Forwarded-For` and every login would come from a Cloudflare IP, which breaks the per-IP login rate limit.

**Hosted Postgres** (version 16 or later). Create a database and a user for staging. Use the provider's **direct** connection string, not a transaction-mode pooler: migrations and pg-boss need a session connection. The API opens up to about 15 connections (Prisma pool 10, pg-boss 5).

**Cloudflare R2:**

1. R2 → **Create bucket**: name `camex-invoices-staging`, location automatic. Leave it private: no public access, no r2.dev URL, no custom domain.
2. R2 → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to **that one bucket** only. Copy the Access Key ID, the Secret Access Key (shown once) and the S3 endpoint `https://<account_id>.r2.cloudflarestorage.com`. A bucket created in a jurisdiction (EU) uses `https://<account_id>.eu.r2.cloudflarestorage.com` instead.
3. Protection: see §7 (bucket lock rule).

The token can read, write and list objects, which is all the app does. The health check uses ListObjectsV2 for that reason: HeadBucket is a bucket operation.

## 1. Dokploy: API application

Create Service → **Application**, name `camex-api`.

| Field               | Value                            |
| ------------------- | -------------------------------- |
| Provider            | GitHub (or Git), this repository |
| Branch              | `main`                           |
| Build Path          | `/`                              |
| Build Type          | **Dockerfile**                   |
| Docker File         | `apps/api/Dockerfile`            |
| Docker Context Path | `.`                              |
| Docker Build Stage  | (empty)                          |

**Environment** tab: the variables in §3. Untick **Create Environment File**: nothing is needed at build time. If it stays on, the generated `.env` is excluded from the build context by `.dockerignore`.

**Domains** tab:

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Host           | `api.camex-fin.site`                       |
| Path           | `/`                                        |
| Container Port | `3000`                                     |
| HTTPS          | on, Certificate Provider **Let's Encrypt** |

**Health check:** path `/api/health`. The image's Docker `HEALTHCHECK` already calls it (via `node`; the image has no curl), and Dokploy uses it when Swarm Settings has no health check of its own, so nothing needs configuring. The check returns 200 when the database and the bucket are reachable, else 503.

On every start the container runs `prisma migrate deploy` and then the server. A failed migration stops the container; the deploy log shows why. Dokploy starts the new container before it stops the old one, so for a moment the old version runs against the migrated schema: migrations have to stay compatible with the running version (add first, remove in a later release).

## 2. Dokploy: web application

Create Service → **Application**, name `camex-web`. Same repository and branch.

| Field               | Value                                     |
| ------------------- | ----------------------------------------- |
| Build Type          | **Dockerfile**                            |
| Docker File         | `apps/web/Dockerfile`                     |
| Docker Context Path | `.`                                       |
| Domain host         | `camex-fin.site`                          |
| Container Port      | `8080`                                    |
| HTTPS               | on, Let's Encrypt                         |
| Health check        | `/healthz` (in the image's `HEALTHCHECK`) |

**Environment** tab: the two variables in §3. The container writes `/config.js` from them at start and refuses to start without `API_BASE_URL`.

## 3. Environment variables

🔒 = secret. Mark these as secrets wherever Dokploy offers it, and never paste them into tickets or chat.

### API (`camex-api`)

| Variable                         | Required                   | Staging value                                                                                                     | Notes                                                                                                                                                         |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                       | no                         | (leave unset)                                                                                                     | The image sets `production`: Secure cookies, `WEB_ORIGINS` required.                                                                                          |
| `PORT`                           | no                         | (leave unset)                                                                                                     | The image listens on `3000`; the Dokploy domain's container port must match.                                                                                  |
| `WEB_ORIGINS`                    | **yes**                    | `https://camex-fin.site`                                                                                          | Comma-separated exact origins (scheme + host, no trailing slash). CORS with credentials for these only; POST/PATCH/DELETE from any other `Origin` get 403.    |
| `TRUST_PROXY`                    | **yes**                    | `1`                                                                                                               | Proxy hops in front of the API (Traefik). Login rate limiting is per client IP, which comes from `X-Forwarded-For`. With `0` every login shares Traefik's IP. |
| `LOG_LEVEL`                      | no                         | `info`                                                                                                            |                                                                                                                                                               |
| `DATABASE_URL` 🔒                | **yes**                    | `postgresql://camex_staging:<url-encoded password>@<host>:5432/camex_staging?sslmode=require&uselibpqcompat=true` | Used by migrations, the app and pg-boss. Encoding and TLS: see below.                                                                                         |
| `S3_ENDPOINT`                    | **yes**                    | `https://<account_id>.r2.cloudflarestorage.com`                                                                   |                                                                                                                                                               |
| `S3_REGION`                      | **yes**                    | `auto`                                                                                                            | R2's region value.                                                                                                                                            |
| `S3_BUCKET`                      | **yes**                    | `camex-invoices-staging`                                                                                          |                                                                                                                                                               |
| `S3_ACCESS_KEY_ID` 🔒            | **yes**                    | (from the R2 token)                                                                                               |                                                                                                                                                               |
| `S3_SECRET_ACCESS_KEY` 🔒        | **yes**                    | (from the R2 token)                                                                                               |                                                                                                                                                               |
| `S3_FORCE_PATH_STYLE`            | **yes**                    | `false`                                                                                                           | Virtual-hosted style, as in Cloudflare's examples (R2 accepts both).                                                                                          |
| `MAILGUN_WEBHOOK_SIGNING_KEY` 🔒 | **yes**                    | (Mailgun, §4)                                                                                                     | Verifies every inbound POST.                                                                                                                                  |
| `OWN_EMAIL_DOMAINS`              | **yes**                    | `camex.aero,camex-fin.site`                                                                                       | Camex's own mail domains (subdomains included, so `mg.camex-fin.site` too). Never used to match a vendor.                                                     |
| `EXTRACTOR_PROVIDER`             | **yes**                    | `anthropic`                                                                                                       | `stub` extracts nothing.                                                                                                                                      |
| `ANTHROPIC_API_KEY` 🔒           | **yes** (with `anthropic`) | (Anthropic console)                                                                                               | About $0.02 per invoice.                                                                                                                                      |
| `EXTRACTION_MODEL`               | no                         | `claude-sonnet-5-5`                                                                                               | Changing it requires an eval run (SPEC §7).                                                                                                                   |
| `EXTRACTION_TIMEOUT_SECONDS`     | no                         | `90`                                                                                                              |                                                                                                                                                               |
| `EXTRACTION_RETRY_DELAY_SECONDS` | no                         | `30`                                                                                                              |                                                                                                                                                               |
| `WORKERS_ENABLED`                | no                         | `true`                                                                                                            | Extraction, recovery sweep and the daily re-evaluation run in this container.                                                                                 |
| `INBOUND_MAX_REQUEST_MB`         | no                         | `30`                                                                                                              | Larger webhook requests get 406 (Mailgun doesn't retry).                                                                                                      |
| `INBOUND_MAX_FILE_MB`            | no                         | `25`                                                                                                              |                                                                                                                                                               |
| `INBOUND_MAX_FILES`              | no                         | `20`                                                                                                              |                                                                                                                                                               |
| `BOOTSTRAP_ADMIN_EMAIL`          | first boot only            | `otto@camex.aero`                                                                                                 | §5. Remove after the first login.                                                                                                                             |
| `BOOTSTRAP_ADMIN_PASSWORD` 🔒    | first boot only            | (12+ characters)                                                                                                  | §5. Must be changed at first login.                                                                                                                           |
| `BOOTSTRAP_ADMIN_NAME`           | no                         | `Otto`                                                                                                            |                                                                                                                                                               |

**`DATABASE_URL` password encoding.** Characters such as `@ : / ? # [ ] % & + =` and spaces must be percent-encoded in the URL. Encode the password without leaving it in your shell history:

```sh
read -rs PW && PW="$PW" node -e 'console.log(encodeURIComponent(process.env.PW))'; unset PW
```

**`DATABASE_URL` TLS.** Migrations (Prisma's schema engine) and the app plus pg-boss (node-postgres) read the same URL but treat `sslmode` differently. Use one of the first two rows:

| URL parameters                         | Migrations                                                              | App and pg-boss               | Use when                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `?sslmode=require&uselibpqcompat=true` | TLS, certificate not verified                                           | TLS, certificate not verified | Default. Works with any provider (libpq's `require`).                                              |
| `?sslmode=require&sslaccept=strict`    | TLS, verified (system CAs)                                              | TLS, verified (Node's CAs)    | The provider's certificate is publicly trusted (e.g. Let's Encrypt).                               |
| `?sslmode=require`                     | TLS, **not** verified                                                   | TLS, verified                 | Don't: the app fails at boot unless the certificate is publicly trusted, and the two sides differ. |
| `?sslmode=no-verify` or `verify-full`  | Prisma doesn't know these and falls back to `prefer` (may be plaintext) | TLS                           | Don't.                                                                                             |
| (none)                                 | `prefer`                                                                | **plaintext**                 | Don't, unless the database is on a private network.                                                |

These were checked against a Postgres with a self-signed certificate (T07 report). With `uselibpqcompat=true` every app and pg-boss connection showed TLS 1.3 in `pg_stat_ssl`. With `sslaccept=strict`, migrations rejected the certificate. With plain `sslmode=require`, migrations ran and the app then refused the certificate.

### Web (`camex-web`)

| Variable        | Required | Staging value                | Notes                                                                                                                                                    |
| --------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`  | **yes**  | `https://api.camex-fin.site` | The API's public base URL, no path. `https://` only (plain `http://` is accepted for localhost, for local checks). The container won't start without it. |
| `INBOX_ADDRESS` | no       | `invoices@mg.camex-fin.site` | Shown on `/inbox` ("Vendors send invoices to …", with a copy button). Unset hides it.                                                                    |

## 4. Mailgun

1. **Domain:** Mailgun → Sending → Domains → **Add new domain** `mg.camex-fin.site`. Pick the region (US or EU) and remember it: routes are region-bound.
2. **DNS:** add the records Mailgun shows. For receiving, the MX records are the ones that matter (EU region: `mxa.eu.mailgun.org` / `mxb.eu.mailgun.org`):

   ```
   mg.camex-fin.site   MX 10   mxa.mailgun.org
   mg.camex-fin.site   MX 10   mxb.mailgun.org
   ```

   Also add the SPF/DKIM TXT records Mailgun lists so the domain verifies. Wait until Mailgun shows the domain as verified.

3. **Route:** Receiving → Routes → **Create route** (routes are per account, in the domain's region):

   ```
   Expression:  match_recipient("invoices@mg.camex-fin.site")
   Actions:     forward("https://api.camex-fin.site/api/inbound/mailgun")
                stop()
   Priority:    0
   Description: camex invoice tracker (staging)
   ```

   Mailgun treats the expression as a regular expression. `match_recipient("^invoices@mg\.camex-fin\.site$")` is the stricter, anchored form. Keep the forward URL as is: Mailgun changes the payload format for URLs ending in `json` or `mime`.

4. **Signing key:** Mailgun dashboard → **Webhooks** page (under Sending) → **HTTP webhook signing key** (reveal it with the eye icon). In some dashboard layouts it is under Account settings → API security. It is the key Mailgun signs route forwards with (HMAC-SHA256 of timestamp + token). Put it in `MAILGUN_WEBHOOK_SIGNING_KEY` on `camex-api` and redeploy. A wrong key makes every inbound POST fail with 401 (Mailgun → Logs shows it).

## 5. First boot

1. On `camex-api`, set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (and optionally `BOOTSTRAP_ADMIN_NAME`). Deploy `camex-api`, then `camex-web`.
2. The API log shows the migrations, then `bootstrap admin created: <email>`.
3. Open `https://camex-fin.site`, log in with that email and password, and set a new password when asked.
4. Remove the three `BOOTSTRAP_ADMIN_*` variables and redeploy `camex-api`. While they are set, the API logs a warning on every start. They are ignored once any user exists.

Other admins are added on `/users`. The CLI also exists in the image, from the Dokploy container terminal of `camex-api`:

```sh
node dist/cli/create-admin.js --email someone@camex.aero --name "Some One"    # prompts for the password
```

## 6. Smoke test

```sh
curl -sS https://api.camex-fin.site/api/health
# {"status":"ok","db":"ok","storage":"ok"}

curl -sS https://camex-fin.site/config.js
# window.__APP_CONFIG__ = {"apiBaseUrl":"https://api.camex-fin.site","inboxAddress":"invoices@mg.camex-fin.site"};

curl -sSI -H 'Origin: https://camex-fin.site' https://api.camex-fin.site/api/health | grep -i '^access-control'
# access-control-allow-origin: https://camex-fin.site
# access-control-allow-credentials: true
```

**Simulated email**, signed with the staging key. This creates three sample invoices on staging and calls the extractor for each (about $0.06). From a checkout of this repo (key read from the terminal, not stored in `.env` or your shell history):

```sh
read -rs MAILGUN_WEBHOOK_SIGNING_KEY && export MAILGUN_WEBHOOK_SIGNING_KEY
pnpm simulate:mailgun --url https://api.camex-fin.site
# POST https://api.camex-fin.site/api/inbound/mailgun
# 200 Invoice SI-000218719 [asm.pdf] → {"inboundEmailId":"…","invoiceIds":["…"]}
# … (three lines, all 200)
unset MAILGUN_WEBHOOK_SIGNING_KEY
```

Or from the Dokploy container terminal of `camex-api`, where the key is already set (it posts to `localhost:3000`):

```sh
node dist/cli/simulate-mailgun.js
```

**Real email:** send an email with a PDF attached to `invoices@mg.camex-fin.site`. Within a minute it is on `https://camex-fin.site/inbox`. The invoice goes from Processing to Needs review, and **Open PDF** shows the file. If nothing arrives, check Mailgun → Logs (route delivery and HTTP status) and the `camex-api` log.

## 7. Backups checklist

- [ ] **Postgres:** daily automated backups on the database host, with at least 14 days retention (point-in-time recovery if the provider has it). Dokploy's own backup feature covers only databases Dokploy runs itself.
- [ ] **R2:** R2 has no object versioning. Protect the PDFs with a **bucket lock rule**: Cloudflare dashboard → R2 → `camex-invoices-staging` → Settings → **Bucket lock rules** → Add rule, prefix `invoices/`, retention **indefinite**, or a fixed number of days on staging. Locked objects can't be deleted or overwritten for the retention period. This needs the dashboard (or an admin token); the app's token can't change it. A bucket with lock rules can't be emptied, so use days rather than indefinite if staging may need wiping.
  - The app never deletes objects and never overwrites one: each PDF is stored once under `invoices/<yyyy>/<mm>/<invoice id>.pdf`.
  - The bucket-scoped token limits the blast radius of a leaked key to this bucket.
- [ ] **Restore drill (to do):** restore the latest Postgres backup into a scratch database, point a local API at it with read access to the bucket, and open a few invoices and PDFs. Write down the date and how long it took.

## 8. Production later

- **Hosts:** new web and API hosts that follow the same-site rule (e.g. `invoices.camex.aero` + `api.invoices.camex.aero`). Update `WEB_ORIGINS`, `API_BASE_URL` and `INBOX_ADDRESS`, add the new domains to `OWN_EMAIL_DOMAINS`, and add DNS A records.
- **Mailgun:** a new Mailgun domain for production (e.g. `mg.invoices.camex.aero`) with its MX records, and a new route forwarding to the production API. Also a new signing key. Mailgun's HTTP webhook signing key belongs to the account, not the domain, so a separate key means a separate Mailgun account or subaccount (see the T07 report's questions).
- **Data:** a separate Postgres database and user, and a separate R2 bucket with its own bucket-scoped token. Never share staging's.
- **Apps:** two new Dokploy applications (or a second environment) with the same build settings and the production variables. Repeat §5 (first boot), §6 (smoke test) and §7 (backups) for production.
