# T01 — Foundation

## 1. Summary

The monorepo (pnpm workspaces: `apps/api` NestJS 12, `apps/web` React + Vite, `packages/shared` zod) is in place with a one-command docker-compose stack (Postgres 16 + MinIO with the bucket auto-created). The full SPEC §5 data model is in the first Prisma migration. Auth uses argon2id passwords, DB-backed sessions, a global guard with `@Public()`, login rate limiting and a `create-admin` CLI. Users management (API + UI) and the web shell (login, sidebar layout, placeholder pages, Users page, change-password and logout) are done. All 38 API tests pass, and lint, typecheck and build are clean, verified from a simulated clean clone. Done-criterion "can log in and manage admins" was exercised in a real browser (headless Chromium walkthrough, see §5).

## 2. What was built

**Repo scaffold**

- `pnpm-workspace.yaml` with `apps/api`, `apps/web`, `packages/shared`. Root scripts: `dev`, `build`, `start`, `lint`, `format`, `typecheck`, `test`, `db:migrate`, `db:migrate:dev`, `create-admin`. A root `postinstall` builds `packages/shared` and generates the Prisma client, so a fresh `pnpm install` leaves every workspace type-checkable.
- `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`). API and shared use `module: nodenext` (ESM); the web app uses bundler resolution.
- One ESLint flat config at the root (`typescript-eslint` **strictTypeChecked** with type info, `no-explicit-any: error`, react-hooks + react-refresh for the web) plus one Prettier config. `pnpm lint` runs both.
- `docker-compose.yml`: Postgres 16 and MinIO. `docker compose up -d --wait` returns once Postgres is ready and the bucket exists.
- `.env.example`: every variable with a one-line comment. One root `.env` is read by the API, the Prisma CLI, the tests and compose.

**Database** (`apps/api/prisma/schema.prisma`, migration `20261002141434_init`)

- All SPEC §5 tables: `users`, `sessions`, `inbound_emails`, `vendors`, `invoices`, `invoice_events`.
- All enums as Postgres enum types: provider, invoice status, extraction status, document type, category, rejection reason, event type.
- Spec precisions: `numeric(18,4)` for money, `char(3)` for currencies, `date` for calendar dates, `timestamptz(3)` for timestamps, uuid PKs (`gen_random_uuid()`), `jsonb` for line items / bank details / flags / attachments / headers, `text[]` for aliases / domains / flight numbers.
- The five spec indexes on `invoices`, plus unique `users.email`, `sessions.token_hash` and `inbound_emails.message_id`.
- Two hand-written additions in the same migration: `CHECK (email = lower(email))` on `users`, and a trigger making `invoice_events` append-only (UPDATE/DELETE raise). A follow-up `prisma migrate dev` produced an empty migration, so Prisma sees no drift from these.

**Auth** (`apps/api/src/auth/`)

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`.
- Passwords are argon2id (library defaults: 64 MiB, t=3, p=4).
- Session token: 32 random bytes (base64url) in the `camex_session` cookie, `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `NODE_ENV=production`. Only the token's SHA-256 (hex) is stored.
- Sessions last 14 days. On use, if `last_seen_at` is older than one hour, both `last_seen_at` and `expires_at` are rewritten and the cookie is re-issued; otherwise there is no write.
- An expired session, or one belonging to a deactivated user, is rejected and deleted, and the response clears the cookie.
- `SessionGuard` is a global `APP_GUARD`; `@Public()` works on a handler or a controller. Public in T01: login and health.
- Login is rate-limited per email (5 failures) and per IP (20 failures) in a 15-minute window, checked before any hashing. Unknown email, wrong password and deactivated user all return the same 401 `Invalid email or password`, and unknown emails still run an argon2 verify against a dummy hash so response time doesn't reveal account existence.
- CLI `pnpm create-admin --email --name [--password]`: hidden TTY prompt (asked twice) when `--password` is omitted. It refuses an existing email (case-insensitive) and validates with the same zod schemas as the API. There is no signup endpoint.

**Users** (`apps/api/src/users/`)

- `GET /api/users`, `POST /api/users` (`email`, `name`, `password`), `PATCH /api/users/:id` (`name`, `isActive`).
- Self-deactivation → 400. Deactivation updates the user and deletes all of the target's sessions in one transaction. Duplicate email → 409.

**Web shell** (`apps/web`)

- Tailwind v4 + shadcn/ui (radix-nova preset, components in `src/components/ui`), React Router 8 (data router), TanStack Query, react-hook-form + zod resolver. Forms use schemas from `@camex/shared`.
- Pages: `/login`, then an authenticated layout with sidebar Invoices / Inbox / Vendors (placeholders) and Users. `/` redirects to `/invoices`; unknown paths show a 404 page.
- `/users`: table, Add user dialog, Deactivate (with confirm dialog), Reactivate, and "(you)" on your own row with no deactivate action.
- User menu: Change password dialog (wrong current password shows on the field) and Sign out.
- Unauthenticated access redirects to `/login` and returns to the requested page after login. Any 401 from any query or mutation signs the UI out.
- Vite proxies `/api` to the API (`VITE_API_PROXY_TARGET`, default `http://localhost:3000`).
- Production: with `NODE_ENV=production` the API serves `apps/web/dist` (or `WEB_DIST_DIR`) with history fallback. `/api/*` is excluded and stays JSON. `index.html` is `no-cache`, `assets/*` are `immutable`. Boot fails if the SPA build is missing.

**Basics**

- `GET /api/health` → `{status:"ok", db:"ok"}`, or 503 `{status:"error", db:"error"}` when `SELECT 1` fails.
- pino via `nestjs-pino`: JSON in production, pino-pretty in development. Request logs carry only method, url, remote address and status (no headers or bodies) and skip non-`/api` paths and `/api/health`.
- Env validated with zod at boot (`apps/api/src/config/env.ts`). On failure the process prints every problem (never the values) and exits 1.
- `StorageModule` / `StorageService` expose a configured `S3Client` and bucket name, verified against MinIO by a `HeadBucket` test.

**Docs**

- `CLAUDE.md` (19 lines) and `README.md` (setup in 7 commands).

**Dependencies added**

- API runtime:
  - `@nestjs/{common,core,platform-express}`, `reflect-metadata`, `rxjs`: framework and its peers.
  - `@nestjs/serve-static`: SPA serving.
  - `@prisma/client` + `@prisma/adapter-pg`: Prisma 7 requires a driver adapter.
  - `argon2`: ships prebuilt binaries, no compiler needed.
  - `cookie-parser`: Express 5 doesn't parse cookies.
  - `nestjs-pino`, `pino`, `pino-http`: structured logging.
  - `@aws-sdk/client-s3`, `zod`.
- API dev:
  - `@nestjs/cli`: build and watch.
  - `prisma`.
  - `vitest` + `unplugin-swc` + `@swc/core`: Vitest's default transformer can't emit decorator metadata, which Nest DI needs.
  - `supertest`.
  - `tsx`: runs the TypeScript CLI in dev.
  - `pino-pretty`.
- Web: `react`, `react-router`, `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, `zod`.
- Web, written by the shadcn CLI: `radix-ui`, `class-variance-authority`, `cn` (shadcn's own compiled replacement for clsx + tailwind-merge, verified as published by shadcn), `lucide-react`, `sonner`, `tw-animate-css`, `shadcn` (dev; its `tailwind.css` is imported).
- Fonts: `@fontsource-variable/atkinson-hyperlegible-{next,mono}`.
- Root dev: ESLint and its plugins, Prettier, TypeScript, `concurrently` (so `pnpm dev` runs three watchers with one command).

## 3. Deviations from SPEC or this prompt

1. **MinIO image.** The official `minio/minio` images are no longer published (pulls fail with "repository does not exist"). Compose uses `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, a maintained community build of the same MinIO server, pinned. The bucket is created by MinIO's own healthcheck (`mc mb --ignore-existing`) instead of a one-shot init container, because `docker compose up --wait` exits 1 when a one-shot container exits (even with code 0). That would have broken "one command brings everything up".
2. **Fixture location.** The prompt and SPEC say `fixtures/invoices/`; the PDFs are actually in `docs/fixtures/invoices/`. I left them untouched (see Questions).
3. **TypeScript 6.0, not 7.0.** npm `latest` is 7.0.2, but `typescript-eslint` supports `<6.1` and `@nestjs/cli` pins `~6.0`. Pinned `~6.0.2`.
4. **Prisma 7.10.0, not "latest".** npm's `latest` tag points to `8.0.0-rc.19`; I chose the newest stable release.
5. **No git commit.** The working directory is not a git repository, so "commit the first migration" means the migration is checked into the tree (`apps/api/prisma/migrations/20261002141434_init/`), ready to commit. I did not run `git init`.
6. **JSON field casing.** The prompt writes `PATCH … (name, is_active)`; the API uses camelCase in JSON (`isActive`, `lastLoginAt`) and snake_case only in the database (Prisma `@map`). This avoids a mapping layer between Prisma and the API; recorded as a question.
7. **Indexes beyond the spec list.** Added `sessions(user_id)` (revocation), `invoices(inbound_email_id)` (Inbox → invoices) and `invoice_events(invoice_id, created_at)` (activity timeline). These are foreign-key lookups later tasks will need.
8. **Database-level enforcement** that SPEC states but doesn't say how to enforce: a lowercase-email CHECK and the append-only trigger (see §2).

## 4. Decisions made that weren't specified

- **Password policy**: 12–256 characters, no composition rules. Login accepts any 1–256 characters, so a future policy change can't lock anyone out.
- **Rate limit**:
  - Counts failed logins only: 5 per email and 20 per IP per fixed 15-minute window.
  - A successful login clears that email's counter.
  - When blocked: 429 `Too many login attempts. Try again later.`. It applies to unknown emails too, so it doesn't reveal whether an account exists.
  - In memory, which matches the single production container in SPEC §3.
- **`TRUST_PROXY` env** (Express trust-proxy hop count, default 0). Without it, per-IP limits behind a reverse proxy would see one shared IP. T07 should set it.
- **Change password** requires the current password (400 `Current password is incorrect` if wrong; 400 rather than 401 so the UI doesn't sign out) and revokes all **other** sessions.
- **Logout** requires a session (only login and health are public per the prompt). The web client treats a 401 on logout as signed out.
- **Expired sessions** are deleted when presented; there is no background sweep yet (pg-boss arrives in T02).
- **Error shapes**: Nest's default `{statusCode, message, error}`; validation errors are `{statusCode:400, message:"Validation failed", issues:[{path, message}]}`. `PATCH /users/:id` rejects unknown keys and empty bodies.
- **`inbound_emails` nullability**: `from_address`, `sender`, `recipient`, `subject`, `body_text`, `headers` are nullable (manual uploads have none). `invoices.page_count` is nullable (unknown until the PDF is read).
- **Generated Prisma client** lives in `apps/api/src/generated/prisma` (git-ignored, regenerated on `pnpm install`).
- **create-admin** sets `created_by_id = null`, refuses an existing email even if that user is deactivated, and requires `--password` when there's no TTY.
- **Tests boot the app with `NestFactory`** and the same `configureApp()` as `main.ts`, not `@nestjs/testing`. The testing module builds the DI graph before an HTTP adapter exists, which silently disables `ServeStaticModule` (found while testing production mode).
- **UI**:
  - Timestamps are shown in Asia/Tbilisi time.
  - The initial-password field in Add user is visible (monospace) so the admin can share it.
  - Deactivation asks for confirmation because it signs the user out immediately.
  - Typeface is Atkinson Hyperlegible Next/Mono, so invoice numbers, IBANs and registrations have unambiguous 0/O and 1/l/I.
  - Amber is reserved for "attention" (current page now, due-soon later).
  - The shadcn `sonner` wrapper was trimmed to drop `next-themes` (no theme switching in v1).

## 5. How to verify

Prerequisites: Node 24+, pnpm 9+, Docker. From a clean clone:

```sh
cp .env.example .env
pnpm install
docker compose up -d --wait            # exits 0; Postgres + MinIO healthy, bucket "camex-invoices" exists
pnpm db:migrate                        # "All migrations have been successfully applied."
pnpm create-admin --email you@camex.aero --name "Your Name"   # prompts twice; prints "Created admin you@camex.aero (<uuid>)."
pnpm create-admin --email YOU@camex.aero --name X --password 'another-password'   # exit 1: "A user with email you@camex.aero already exists."
pnpm test                              # 7 files, 38 tests passed (needs the compose stack up)
pnpm lint && pnpm typecheck            # no output errors; "All matched files use Prettier code style!"
pnpm dev                               # open the URL Vite prints (5173, or the next free port)
```

In the browser:

1. Visiting `/users` redirects to `/login`.
2. A wrong password shows "Invalid email or password". The right one lands you back on `/users`.
3. Add a user: a short password is rejected inline, a duplicate email is shown on the field, and a valid one adds a row.
4. Deactivate the user (confirm dialog). Their row shows "Deactivated" and any session they had is gone. Reactivate them.
5. Your own row has no Deactivate button.
6. User menu → Change password: a wrong current password is shown on the field.
7. User menu → Sign out returns you to `/login`, and `/users` redirects again.

Production mode: `pnpm build && NODE_ENV=production pnpm start`, then:

- `curl -i localhost:3000/users` → 200 HTML with `Cache-Control: no-cache`
- `curl localhost:3000/api/nope` → JSON 404
- The login `Set-Cookie` includes `Secure`

**What I actually ran**:

- All of the above in a scratch copy of the repo (no `node_modules`, `dist`, generated client or `.env`) after `docker compose down -v`, with `--password` instead of the prompt. Everything succeeded, including 38/38 tests with the test database created from nothing.
- The interactive prompt was exercised separately through a pseudo-terminal (typed, pasted-both-at-once, mismatch).
- The browser steps were run as a headless-Chromium Playwright script against `pnpm dev`. All steps passed, with no JavaScript errors (the console only showed the browser's network log for the intentional 401/409/400 responses).
- The production-mode `curl` checks were run against `node apps/api/dist/main.js`.
- Env fail-fast was checked by booting with a bad `DATABASE_URL` and with no `.env` (exit 1, problems listed, no values echoed).

## 6. Test results

`pnpm test` (runs `vitest run` in `apps/api` against `TEST_DATABASE_URL`; global setup runs `prisma migrate deploy` there, which also creates the database):

```
 ✓ test/create-admin.e2e.test.ts > pnpm create-admin > creates a working admin user
 ✓ test/create-admin.e2e.test.ts > pnpm create-admin > refuses a duplicate email
 ✓ test/create-admin.e2e.test.ts > pnpm create-admin > rejects a weak password and missing arguments
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/login > logs in, sets an httpOnly SameSite=Lax cookie and stores only the token hash
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/login > returns the same generic 401 for wrong password, unknown email and inactive user
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/login > rejects malformed input with 400
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/login > rate-limits failed attempts per email, across IPs
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/login > rate-limits failed attempts per IP, across emails
 ✓ test/auth.e2e.test.ts > auth > sessions > rejects an expired session and deletes it
 ✓ test/auth.e2e.test.ts > auth > sessions > extends the session on use, writing at most once per hour
 ✓ test/auth.e2e.test.ts > auth > sessions > logout invalidates the session
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/change-password > requires the current password
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/change-password > changes the password and signs out other sessions only
 ✓ test/auth.e2e.test.ts > auth > POST /api/auth/change-password > enforces the password policy
 ✓ test/users.e2e.test.ts > users > lists users without password hashes
 ✓ test/users.e2e.test.ts > users > creates a user who can then log in
 ✓ test/users.e2e.test.ts > users > refuses a duplicate email with 409
 ✓ test/users.e2e.test.ts > users > validates input
 ✓ test/users.e2e.test.ts > users > renames a user
 ✓ test/users.e2e.test.ts > users > cannot deactivate yourself
 ✓ test/users.e2e.test.ts > users > deactivation revokes the target's sessions; reactivation allows login again
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated get /api/auth/me with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated post /api/auth/logout with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated post /api/auth/change-password with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated get /api/users with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated post /api/users with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated patch /api/users/00000000-0000-0000-0000-000000000000 with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks unauthenticated get /api/probe/private with 401
 ✓ test/guard.e2e.test.ts > global session guard > blocks an unknown session token
 ✓ test/guard.e2e.test.ts > global session guard > lets @Public routes through without a session
 ✓ test/guard.e2e.test.ts > global session guard > lets authenticated requests through
 ✓ test/production.e2e.test.ts > production mode > serves the SPA with history fallback
 ✓ test/production.e2e.test.ts > production mode > keeps /api routes on the API (JSON 404, guard still applies)
 ✓ test/production.e2e.test.ts > production mode > sets the Secure flag on the session cookie
 ✓ test/storage.e2e.test.ts > storage module > is configured against the docker-compose bucket
 ✓ test/env.test.ts > parseEnv > applies defaults
 ✓ test/env.test.ts > parseEnv > fails fast listing every problem, treating empty strings as missing
 ✓ test/env.test.ts > parseEnv > never echoes values
 Test Files  7 passed (7)
      Tests  38 passed (38)
   Duration  14.13s
```

Every scenario the prompt asked for is covered:

- Login success and failure, and both rate limits.
- Expired session rejected; logout invalidates the session.
- Guard blocks unauthenticated requests; `@Public` routes pass (real routes plus test-only probe controllers, one method-level and one class-level).
- Cannot deactivate yourself; deactivation revokes the target's sessions.
- `create-admin` (the real CLI as a subprocess) creates a working user and refuses a duplicate.

`pnpm lint` → ESLint clean, `All matched files use Prettier code style!`. `pnpm typecheck` → shared, web and api all `Done`. `pnpm build` → all three `Done`.

## 7. Known issues / shortcuts

- **Web bundle** is one 648 kB chunk (203 kB gzip). Vite warns. There's no code splitting yet; acceptable for an internal tool, easy to split per route later.
- **Rate limiter and sessions**:
  - Limiter state is per process and resets on restart. Fine for one container, wrong if the API is ever scaled out.
  - Expired session rows accumulate until presented; a daily cleanup job belongs with pg-boss (T02).
- **`--password` on `create-admin`** is visible in shell history and the process list. It's documented as being for scripts; the interactive prompt is the default.
- **Calendar dates**: Prisma returns `@db.Date` columns as JS `Date` at UTC midnight. No date fields are used in T01, so there's no `YYYY-MM-DD` ↔ `Date` boundary helper yet; T03 should add one in one place.
- **Mobile**: the sidebar becomes a top bar and the users table scrolls horizontally. That meets "not broken", nothing more.
- **Bucket creation in a healthcheck** is unconventional (the healthcheck mutates state, idempotently). It's local dev only.
- **Lint and tooling**:
  - shadcn components under `apps/web/src/components/ui` are excluded from ESLint (generated code) but are Prettier-formatted.
  - Type-aware linting makes `pnpm lint` take roughly 20–30 s.
  - The Prisma CLI prints an "update available: 8.0" banner; ignored on purpose (8.0 is a release candidate).
- **No web unit tests.** None were requested; the UI was verified with the scripted browser walkthrough described in §5, which is not committed.
- **pnpm** is pinned to 9.8.0 via `packageManager` (the locally installed version). Current pnpm is 12.x; worth a deliberate bump.
- **Environment incident during verification** (not a code issue): between sessions the local Postgres container was restarted externally and came back without its port mapping (ECONNREFUSED). `docker compose up -d --force-recreate postgres` fixed it.

## 8. Questions for the CTO

1. **Fixtures path**: the files are in `docs/fixtures/invoices/`, but SPEC §2/§7 and the prompt say `fixtures/invoices/`, and T03's eval expects `fixtures/invoices/expected/*.json`. Should they move to the repo root, or should the spec change?
2. **Local S3**: is `pgsty/minio` (community build of MinIO) acceptable for local dev, or would you prefer a different S3-compatible server? Production uses a real bucket either way.
3. **JSON casing**: camelCase in the API (`isActive`) vs snake_case in the data model. OK to standardise on camelCase for all JSON in later tasks (invoices: `amountDue`, `amountDueCurrency`, …)?
4. **Password policy** (≥12 characters) and **rate limits** (5 per email / 20 per IP per 15 minutes): acceptable?
5. **S3 credentials** are required at boot. If production runs on AWS with an instance or task role, T07 should make the keys optional. Is that the plan?
6. **Append-only `invoice_events`** is enforced by a trigger, so invoices referenced by events can never be deleted (the FK is `RESTRICT`). That matches "rejected, never deleted", but confirm no admin "delete invoice" is expected.
