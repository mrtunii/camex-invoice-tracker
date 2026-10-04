# T02 — Ingestion + bootstrap admin

Branch `t02-ingestion`, one commit "T02: ingestion + bootstrap admin" on top of `main` (not merged, not pushed).

## 1. Summary

Invoices now arrive two ways, through one ingestion path. The ways are a signed Mailgun webhook and a manual upload. The path:

- stores each PDF in the bucket;
- writes the email, one invoice per PDF and a `received` event in one transaction;
- enqueues one pg-boss extraction job per invoice.

A stub extractor moves each invoice from `processing` to `needs_review` (or to `extraction_failed` after the last of 3 attempts). A recovery sweep re-enqueues stuck rows.

The `/inbox` page lists every email and upload, opens the PDFs and shows the body in a side sheet. The upload dialog is reusable.

The first admin is created from `BOOTSTRAP_ADMIN_*` on boot. Anyone whose password was set by someone else (bootstrap, admin-created, admin reset) must change it before the API serves them anything else.

Results:

- 88/88 API tests pass (13 files, against compose Postgres + MinIO, no S3 mocks).
- Lint, typecheck and build are clean.
- Both done criteria were run end to end: in a clean clone under a separate compose project (production mode, empty database), and in a headless-Chromium walkthrough against `pnpm dev`. See §5.

## 2. What was built

**Housekeeping**

- Fixtures moved to `fixtures/invoices/{asm,petrocas,aeg}.pdf` (git renames, bytes unchanged). `.prettierignore` updated. The T01 report still names the old path; it is a historical record, so I left it as is.
- docker-compose:
  - Project name `camex-invoices`.
  - Host ports: Postgres 55432, MinIO API 59000, console 59001.
  - MinIO stays pinned to `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`.
- Dev ports: API on 3180; Vite on 5180 with `strictPort`. The proxy default is 3180.
- `.env.example`, README, CLAUDE.md (new "Safety rules" section, ports, simulator), and the three SPEC edits (§5 casing, §11 bootstrap/forced change/reset, §14 branch + diff stat).

**Bootstrap admin and forced password change** (`apps/api/src/auth/`)

- Config (`config/env.ts`):
  - `BOOTSTRAP_ADMIN_EMAIL` uses the shared email schema and `BOOTSTRAP_ADMIN_PASSWORD` the shared password policy. `BOOTSTRAP_ADMIN_NAME` defaults to `Admin`.
  - A cross-field rule requires both or neither. Any violation fails boot with `Invalid environment configuration: - BOOTSTRAP_ADMIN_PASSWORD: Use at least 12 characters`, and values are never echoed.
- `BootstrapAdminService.onApplicationBootstrap` runs during `app.init()`, before `listen`:
  - It creates the user only if the users table is empty, with `is_active=true` and `must_change_password=true`, and logs `bootstrap admin created: <email>`.
  - If any user exists it changes nothing, and logs a warning when the vars are still set.
  - A P2002 on the email is logged as "already created", not an error.
  - With no users and no vars, it logs a hint.
- Migration `20261004110015_must_change_password` adds `users.must_change_password boolean not null default false`. The flag is set:
  - for the bootstrap admin;
  - for users created via `POST /api/users`;
  - on admin reset.

  A successful change-password clears it. `pnpm create-admin` users are not flagged (they typed their own password).

- `SessionGuard`: while the flag is set, only routes marked `@AllowDuringPasswordChange()` pass. Those are `GET /auth/me`, `POST /auth/change-password` and `POST /auth/logout`. Everything else returns 403 `{statusCode, code: "PASSWORD_CHANGE_REQUIRED", message}`. `/auth/me` and the login response include `mustChangePassword`.
- `POST /api/users/:id/reset-password {newPassword}`:
  - It sets the hash and the flag and deletes all of the target's sessions in one transaction, then returns the user.
  - Your own id gives 400; an unknown id gives 404.
- Change-password now rejects a new password equal to the current one (shared schema).

**Storage** (`storage/storage.service.ts`)

- `put(key, buffer, contentType)` and `getStream(key)` use the standard S3 API only (PutObject/GetObject). Path-style is still the `S3_FORCE_PATH_STYLE` flag.
- `invoicePdfKey(id, receivedAt)` → `invoices/{yyyy}/{mm}/{invoiceId}.pdf`.
- `INBOUND_MAX_FILE_MB` (default 25) and `INBOUND_MAX_FILES` (default 20) feed the multer limits.

**Ingestion** (`ingestion/`)

- `IngestionService.ingest()` is the single path for Mailgun and manual uploads:
  1. A PDF must be declared as one (`application/pdf`, parameters ignored, or a name ending in `.pdf`, any case) and its bytes must start with `%PDF-`. Anything else is recorded in `inbound_emails.attachments` with `processed: false` and not stored.
  2. For each PDF it computes the sha256 and the page count (pdf-lib, `ignoreEncryption`; null if unparseable, still ingested), then uploads it in parallel.
  3. One transaction writes the `inbound_email`, the invoices (`processing` / `pending`) and one `received` event each (`{source, inboundEmailId}`).
  4. After the commit it enqueues the extraction jobs.
  5. If the commit fails, the uploaded keys are logged as orphans.
- Text is cleaned before storage: NUL characters are stripped (Postgres rejects them in text and jsonb). Filenames are reduced to their basename, control characters are removed and they are capped at 255 characters. The body keeps its first 20,000 characters, without splitting a surrogate pair.

**Mailgun webhook** — `POST /api/inbound/mailgun` (`@Public`)

- Multer memory storage via `MulterModule.registerAsync`:
  - Limits come from config, plus `fieldSize` 10 MB and `fields` 500.
  - `defParamCharset: 'utf8'`, so names like `ინვოისი №510.pdf` survive (multer's default is latin1).
  - Without attachments Mailgun posts urlencoded (see §3), so a 30 MB urlencoded parser is scoped to this one path.
- Signature: hex HMAC-SHA256(key, timestamp + token) compared with `timingSafeEqual` after a length check. Invalid or missing gives 401 and nothing is stored. There is no timestamp window.
- Message-Id comes from the `Message-Id` field (case-insensitive), then from `message-headers`, then falls back to `mailgun:<token>`.
  - An existing Message-Id gives 200 `{duplicate: true}` before any upload.
  - Two deliveries racing past that check hit the unique index (P2002) and also get `{duplicate: true}`.
- `from_address` is parsed from the display form and lowercased, falling back to `sender`. Headers are stored as `[name, value]` pairs.
- Logs: message-id, sender, PDF count, ignored count. Never bodies or file contents.
- Responds 200 `{inboundEmailId, invoiceIds}` after the commit. Unexpected errors give 500.

**Manual upload** — `POST /api/invoices/upload` (session)

- Multipart field `files`, 1–20 files. Zero files or more than 20 gives 400.
- If any file fails the PDF rule, the response is 400 `{message, rejectedFiles: [...]}` and nothing is stored.
- Otherwise it creates an `inbound_email` with provider `manual`, subject "Manual upload", `from_address` = uploader email and `uploaded_by_id`, then follows the same path. Response 201.

**Extraction jobs** (`jobs/`, `extraction/`)

- `JobsService`:
  - Owns one pg-boss 12 instance on `DATABASE_URL` (schema `pgboss`, pool max 5). It starts in `onModuleInit` and stops gracefully (20 s timeout) in `beforeApplicationShutdown`.
  - `error` and `warning` events are logged as message only (an unhandled `error` event would crash the process).
  - Prisma and S3 now close in `onApplicationShutdown`, so in-flight jobs and requests can finish first.
- Queue `invoice.extract`:
  - Policy `exclusive`: at most one queued/retrying/active job per `singletonKey` = invoiceId.
  - `retryLimit: 2` (3 attempts), `retryBackoff: true`, base `retryDelay` = `EXTRACTION_RETRY_DELAY_SECONDS` (default 30).
  - `expireInSeconds: 300`. Retry options are passed on every `send`, so config changes apply even though the queue row persists.
  - The worker runs with `localConcurrency: 2` and `includeMetadata: true`.
- `InvoiceExtractor` interface plus `StubExtractor` (500 ms, `{model:'stub', promptVersion:'stub', raw:{}}`), chosen by the required `EXTRACTOR_PROVIDER` (only `stub` exists).
- `ExtractionHandler`:
  - It loads the invoice and exits if it is not `processing`.
  - It reads the PDF from S3 and calls the extractor.
  - In one transaction it stores the raw output, model, prompt version and `extracted_at`, sets `succeeded` / `needs_review` and writes an `extracted` event. The update is conditional on `status = processing`, so a concurrent run can't apply twice.
- **Final-attempt detection.** The job is fetched with metadata, so the handler sees `retryCount` (0 on the first attempt; pg-boss increments it each time the job is claimed again) and `retryLimit` (2).
  - When the extractor (or the S3 read, or the success write) throws and `retryCount >= retryLimit`, this is the last attempt. The handler sets `extraction_status=failed`, `extraction_error` (message only, capped at 1,000 characters) and `status=needs_review`, and writes an `extraction_failed` event `{error, attempts}` in one transaction.
  - It then rethrows, so pg-boss also records the job as `failed`.
  - On earlier attempts it only rethrows, and pg-boss schedules the retry with backoff.
  - The test confirms 3 extractor calls, one `extraction_failed` event, and the pg-boss job `failed` with `retryCount` 2.
  - Gap: if the last attempt never reaches the `catch` (process killed, attempt over 5 minutes), pg-boss fails the job without calling the handler. The recovery sweep covers that.
- Recovery sweep (`RecoverySweep`):
  - pg-boss cron `*/5 * * * *` on queue `invoice.recover` (policy `singleton`).
  - It picks `processing` invoices with `updated_at` older than 10 minutes (batch 500) and enqueues them. The `exclusive` policy turns an invoice that still has a live job into a no-op.
- `WORKERS_ENABLED` (default true) runs the workers in-process. Tests switch them off except where they test the worker.

**Read endpoints**

- `GET /api/inbox?cursor=&limit=` (default 25, max 100):
  - Newest first by `(received_at, id)`, cursor = last id. Returns `{items, nextCursor}`.
  - Each item has `id, provider, receivedAt, fromAddress, subject, attachments [{filename, contentType, size, processed}], invoices [{id, status, extractionStatus, fileName}]`.
- `GET /api/inbox/:id` returns the same plus `bodyText` and `headers`.
- `GET /api/invoices/:id/file`:
  - Streams from S3 with `Content-Type: application/pdf`, `Content-Length` and `Content-Disposition: inline; filename="<ascii fallback>"; filename*=UTF-8''<exact name>`.
  - Also sends `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
  - A missing S3 object gives 404 (logged).

**Web** (`apps/web`)

- `/inbox`:
  - Table columns: received, from (plus a "Manual upload" badge), subject, invoices as status chips (status, file name, "Open PDF" in a new tab), ignored attachment names.
  - Clicking a row (or the subject button, for keyboard users) opens a side sheet with the invoices, attachments, plain-text body and collapsible headers.
  - "Load more" pagination. Refetches every 5 s while any loaded invoice is `processing` (list and open sheet).
- `UploadInvoicesDialog` (`components/`, reusable; takes `onUploaded` and an optional `trigger`):
  - Drag & drop or file picker, multiple files.
  - Per-file errors: the same PDF rule client-side, including the `%PDF-` bytes, plus server-rejected names.
  - Shows a message on 413 and a toast on success. The Upload button stays disabled while any file has an error.
- `InvoiceStatusBadge` is reusable. Amber marks Needs review; Processing shows a spinner; failed extraction adds a "· extraction failed" marker.
- Forced "Set a new password" screen:
  - `RequireAuth` renders it instead of the app while `mustChangePassword` is true, with a "Sign out" link.
  - A 403 `PASSWORD_CHANGE_REQUIRED` from any query flips the flag, for example after an admin reset while you're signed in.
  - The change-password form is shared with the existing dialog.
- `/users`: "Reset password" button and dialog on other users' rows (temporary password shown in monospace, like Add user). A "Temporary password" badge appears while a user's flag is set.

**Dev tooling** — `pnpm simulate:mailgun`

- Sends correctly signed posts using `MAILGUN_WEBHOOK_SIGNING_KEY` and `PORT` from `.env`: multipart with attachments, urlencoded without, like Mailgun.
- Flags: `--file` (repeatable; paths relative to where you ran pnpm), `--from`, `--subject`, `--message-id`, `--extra-attachment`, `--bad-signature`, `--help`.
- With no flags it sends three emails, one per fixture, from fictional `.example` vendor addresses.

**Dependencies added (API)**

- `pg-boss@^12.36.0`: the job queue SPEC §3 names. It brings `pg`, `cron-parser`, `rrule-temporal`, `serialize-error` and the `@opentelemetry/api` peer (no-op without an SDK).
- `pdf-lib@^1.17.1`: page count only (the prompt names it). npm shows 1.17.1 as the latest version and no registry change since May 2022.
- `express@5.2.1`: the exact version `@nestjs/platform-express` already uses. It is imported directly only for the route-scoped `urlencoded` parser.

**Web additions**

- shadcn `sheet` component; no new packages.

## 3. Deviations (with reasons)

1. **Mailgun field names vs. current docs.** I checked Mailgun's current "Receive / forward() route" page and the webhook-signing page; I had no Mailgun account to capture a real delivery. Differences from the list in the prompt:
   - **`Message-Id` is not a documented top-level field.** The documented fields are `recipient, sender, from, subject, body-plain, body-html` (documented as an array), `stripped-text/-signature/-html`, `message-headers` (JSON `[[name, value], …]`), `attachment-count`, `attachment-N`, `content-id-map`, `timestamp`, `token` and `signature`. The docs say `message-headers` exists "because not all web frameworks support multi-valued keys parameters", which implies headers are also posted as fields, but that isn't specified. So I read `Message-Id` case-insensitively from the fields first, then from `message-headers`, then fall back to `mailgun:<token>`. All three paths are tested.
   - **The POST is `application/x-www-form-urlencoded` when the email has no attachments**, multipart only with attachments. Express's default urlencoded limit is 100 kB, so a 30 MB parser is mounted on this route only (SPEC §4 "body limit ≥ 30 MB").
   - Retries: 200 is done, 406 is "rejected, no retry", anything else is retried for about 8 hours (10 min, 15 min, 30 min, 1 h, 2 h, 4 h).
   - Signature: as specified, using the "HTTP webhook signing key".
2. **`StorageService.put(key, buffer, contentType)`, not `put(buffer, contentType)`.** The key contains the invoice id, which is generated before the row exists. Callers build it with `invoicePdfKey(invoiceId, receivedAt)`.
3. **The MinIO image was already pinned** (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, from T01); I kept that tag.
4. **The env schema's default `PORT` is now 3180** (was 3000), so a missing `PORT` still matches the Vite proxy target.
5. **Tests use their own bucket, `TEST_S3_BUCKET`** (new variable, default `camex-invoices-test`). Global setup creates and empties it, mirroring `TEST_DATABASE_URL`, so tests never write into the dev bucket.

## 4. Decisions not in the spec

- **Config surface:**
  - `INBOUND_MAX_FILES` (20) is the multer file count.
  - `EXTRACTION_RETRY_DELAY_SECONDS` (30): the backoff gives roughly 30–60 s before attempt 2 and 60–120 s before attempt 3. Tests use 1.
  - `WORKERS_ENABLED` (true).
  - `EXTRACTOR_PROVIDER` is **required** (no default), so a deployment can't silently run the stub.
  - `MAILGUN_WEBHOOK_SIGNING_KEY` is required. `.env.example` carries the local placeholder `local-dev-only-signing-key`, which is not a credential.
- **`received_at`** is the time the API received the request (same for uploads). I didn't use Mailgun's `timestamp` or the email's `Date` header.
- **Storage key month** is taken in UTC (it's a partition, not business logic).
- **`inbound_emails.attachments`** keeps SPEC §5's snake_case keys in the jsonb (`content_type`). The API maps them to camelCase.
- **Duplicates are checked before uploading**, so a replay costs one indexed lookup and no S3 traffic.
- **A failed enqueue after commit is logged and still returns 200.** The rows exist, so the recovery sweep picks them up within about 15 minutes, and a 500 would only make Mailgun retry into a duplicate.
- **Mailgun limits errors** (file too big: 413; too many files or fields: 400) use Nest's default mapping. See Questions.
- **Job settings:** `expireInSeconds` 300 (below the sweep's 10-minute threshold); queue policies `exclusive` (extract) and `singleton` (recover); cron schedule rather than `setInterval`, so only one instance sweeps if there are ever several.
- **Extraction storage:** the raw output is made jsonb-safe (JSON round trip, NUL characters stripped).
- **Inbox:** within an email, invoices are sorted by file name. Page size is 25.
- **Reset password** is allowed on deactivated users (they still can't sign in until reactivated) and returns the updated user.
- **UI:** amber "Needs review" chip; "Temporary password" badge on `/users`; the email sheet shows headers collapsed.
- **Simulator:** sender addresses are fictional, on the reserved `.example` TLD (no real vendor domains).

## 5. How to verify

Prerequisites: Node 24+, pnpm 9+, Docker. From a clean clone:

```sh
git clone <repo-url> camex && cd camex && git checkout t02-ingestion
cp .env.example .env
# edit .env: BOOTSTRAP_ADMIN_EMAIL=you@camex.aero and BOOTSTRAP_ADMIN_PASSWORD=<12+ characters of your choice>
pnpm install
docker compose up -d --wait            # project "camex-invoices": Postgres :55432, MinIO :59000/:59001, healthy
pnpm db:migrate                        # "All migrations have been successfully applied." (2 migrations)
pnpm test                              # 13 files, 88 tests passed (~45 s; creates camex_test DB and test bucket)
pnpm lint && pnpm typecheck && pnpm build
pnpm dev                               # API :3180 logs "bootstrap admin created: you@camex.aero"; web http://localhost:5180
```

In the browser:

1. Sign in with the bootstrap admin. You get the "Set a new password" screen at any URL. Reusing the temporary password is refused.
2. Set a password. You land on `/inbox` (empty).
3. In a terminal: `pnpm simulate:mailgun` prints three `200 … {"inboundEmailId":…,"invoiceIds":[…]}` lines. On `/inbox` three rows appear with **Processing** chips, which turn **Needs review** within one 5 s poll.
4. "Open PDF" opens the original PDF in a new tab. Clicking a row opens the sheet with the email body.
5. "Upload PDFs": drop `fixtures/invoices/aeg.pdf` and any non-PDF. The non-PDF shows "Not a PDF" and Upload is disabled. Remove it and upload; a "Manual upload" row appears.
6. `pnpm simulate:mailgun --message-id '<x@y>' --file fixtures/invoices/asm.pdf` twice. The second prints `{"duplicate":true}` and no row is added. `--bad-signature` prints 401.
7. `/users`: add a user (badge "Temporary password"), then "Reset password". That user is signed out and must set a new password at next sign-in. Your own row has no reset button.
8. Restart `pnpm dev` with the variables still set: the log warns `BOOTSTRAP_ADMIN_* is set but users already exist…` and nothing changes.

**What I actually ran**

- **Clean clone.** I cloned the committed branch into a temp directory and ran it under `docker compose -p camex-invoices-check`. Ports were remapped to 56432/60000/60001 and API 3180 → 3181 so it could run next to the dev stack; bootstrap vars were set as above.
  - `pnpm install --frozen-lockfile`, `up -d --wait`, `db:migrate`, `pnpm test` (88/88), lint, typecheck and build all succeeded.
  - Then `NODE_ENV=production pnpm start` on the **empty** database:
    - The log had `bootstrap admin created: first.admin@camex.aero`, and 0 lines contained the password.
    - Login returned `mustChangePassword: true` with a `Secure; HttpOnly; SameSite=Lax` cookie.
    - `GET /api/inbox` gave 403 `PASSWORD_CHANGE_REQUIRED`. Change-password gave 204, then `/api/inbox` gave 200.
    - `pnpm simulate:mailgun`: all three invoices were `needs_review` **3.9 s** after sending.
    - The downloaded `petrocas.pdf` had the same sha256 as the fixture.
    - A manual upload gave 201. A mixed upload gave 400 `rejectedFiles: ["README.md"]`.
    - A Message-Id replay returned `{"duplicate":true}`. The DB held `mailgun: 4, manual: 1`.
    - A second boot with the vars still set logged the warning, and the user was unchanged.
  - I stopped the server by its recorded process group and ran `docker compose -p camex-invoices-check down -v` (0 containers and volumes left). The dev stack was not touched.
- **Browser.** A headless-Chromium (Playwright) walkthrough against `pnpm dev` covered every step in the list above, including the mobile viewport (the table scrolls inside its card, no page overflow). No console or page errors. Chips left Processing on the first poll (5.0 s). "Load more" went from 25 to 31 rows. The script and screenshots live outside the repo.

## 6. Test results

`pnpm test` → `Test Files 13 passed (13)`, `Tests 88 passed (88)`, `Duration 45.35s`. The 38 T01 tests still pass. Some assertions were updated for the new `mustChangePassword` field (auth, users) and the 3180 default port (env), and the guard's route list grew by the new routes. Full list (`pnpm --filter @camex/api exec vitest run --reporter=verbose`):

```
✓ extraction > worker > moves the invoice to needs_review with an `extracted` event
✓ extraction > worker > after the last of 3 failed attempts: extraction failed, needs_review, one `extraction_failed`
✓ extraction > worker > is idempotent: an invoice that is no longer processing is left alone
✓ extraction > recovery sweep > re-enqueues invoices stuck in processing for over 10 minutes, once
✓ extraction > recovery sweep > ignores invoices that are not processing
✓ mailgun > signature > accepts a valid signature
✓ mailgun > signature > rejects an invalid signature / wrong length / another key / missing signature / missing token / missing timestamp with 401 and stores nothing   (6 tests)
✓ mailgun > signature > rejects a token signed with a different timestamp
✓ mailgun > stores the email, its PDFs and invoices, and enqueues one job per invoice   (email row, invoices, events, S3 bytes, pg-boss jobs)
✓ mailgun > treats application/octet-stream named *.pdf as a PDF
✓ mailgun > ignores a .pdf whose bytes are not a PDF
✓ mailgun > ingests a PDF pdf-lib cannot parse, with a null page count
✓ mailgun > stores an email without attachments (urlencoded, like Mailgun) with zero invoices
✓ mailgun > processes the same Message-Id only once
✓ mailgun > takes the Message-Id from message-headers, else falls back to mailgun:<token>
✓ mailgun > keeps the first 20k characters of the body and UTF-8 filenames
✓ mailgun > rejects a file over INBOUND_MAX_FILE_MB with 413 and stores nothing
✓ bootstrap admin > creates the admin on an empty database, who must then change the password
✓ bootstrap admin > does nothing when a user exists, even with a different email
✓ bootstrap admin > never updates or reactivates a deactivated user with the same email
✓ bootstrap admin > treats a concurrent boot that lost the race as "already created"
✓ bootstrap admin > fails boot with a clear message on invalid config, without printing the password   (real `tsx src/main.ts`, exit 1)
✓ must_change_password > allows only me, change-password and logout until the password is changed
✓ must_change_password > lets a flagged user sign out
✓ must_change_password > flags users created by another admin
✓ reset-password > sets a temporary password, revokes the target's sessions and flags them
✓ reset-password > rejects resetting yourself
✓ reset-password > validates input and 404s an unknown user
✓ upload > requires a session (401 before anything is read)
✓ upload > creates a manual inbound email with one invoice per PDF and enqueues extraction
✓ upload > rejects the whole batch when any file is not a PDF, listing the rejected names
✓ upload > rejects an empty upload and more than 20 files
✓ inbox > lists emails newest first with attachments (incl. ignored) and invoices, paginated
✓ inbox > returns one email with its body and headers
✓ inbox > streams the original PDF byte for byte, inline with its filename, never cached   (also 401 without session)
✓ env > applies defaults · BOOTSTRAP_ADMIN_*: accepts the pair; rejects email-only, password-only, weak password, bad email without echoing   (6 tests)
✓ guard > blocks unauthenticated requests with 401 on 12 routes, now incl. reset-password, inbox, inbox/:id, upload, file   (12 tests)
✓ T01 suites, unchanged in substance: auth (11), create-admin (3), users (7), production (3), storage (1),
  env (fails fast, never echoes), guard (unknown token, @Public, authenticated)
```

`pnpm lint` → ESLint clean, `All matched files use Prettier code style!`. `pnpm typecheck` → shared, api and web all `Done`. `pnpm build` → all three `Done` (Vite still prints T01's chunk-size warning).

## 7. Known issues / shortcuts

- **Rejected-by-limit emails are lost silently.** A file over `INBOUND_MAX_FILE_MB`, or more than `INBOUND_MAX_FILES` attachments, gives 413/400. Mailgun retries for about 8 hours and then drops it, and nothing appears in the Inbox. Only a warning-level request log line remains.
- **Memory.** The signature fields are inside the multipart body, so multer buffers the whole request in memory before the signature can be checked. Per-file and per-count limits apply, but there is no total cap. The theoretical worst case is 20 × 25 MB of files plus large text fields per request on a public endpoint.
- **A permanently hanging extractor loops.** pg-boss expires each attempt after 5 minutes; after the third, the job fails without the handler running. The sweep re-enqueues 10+ minutes later with fresh attempts, and this repeats indefinitely. T03 should give the provider call its own timeout well below 5 minutes, so failures go through the handler's final-attempt path.
- **Orphaned S3 objects** (upload succeeded, commit failed) are logged, not cleaned up.
- **pdf-lib is unmaintained** (latest 1.17.1). It's only used for page counts and failures are tolerated (null).
- **No timestamp window** on Mailgun signatures, as specified (replays are idempotent). A captured request can be replayed, but it only ever hits the duplicate path.
- **Polling.** The Inbox refetches all loaded pages every 5 s while anything is processing. Fine for this volume.
- **Mobile.** The Inbox table scrolls horizontally inside its card. That meets "not broken", nothing more.
- **Expired sessions** still accumulate until presented. pg-boss is now available for a cleanup job, but it wasn't in this task's scope.
- **Local environment state (not code):**
  - The T01 compose project `camex-invoice-tracker` is still running on 5432/9000/9001 with its volumes (including the T01 dev admin). The new project `camex-invoices` started with an empty database. I didn't stop the old one (safety rules); `docker compose -p camex-invoice-tracker down` stops it when no longer needed.
  - The new dev database contains my verification data: emails, invoices, the users `admin@camex.aero` (bootstrap) and `nino@camex.aero`, and objects in the `camex-invoices` bucket.

## 8. Questions for the CTO

1. **Emails rejected by size/count limits:** should the webhook answer 406 so Mailgun stops retrying, and/or store the email with that attachment marked "too large" so finance sees it in the Inbox? The second needs a custom multer storage engine; I'd suggest it before go-live.
2. **Total request cap:** is the per-request worst case in §7 acceptable, or should we enforce a total body limit (e.g. reject by `Content-Length` > 30 MB before parsing)?
3. **Stuck extractions:** should the sweep give up after N re-enqueues (e.g. count `received`/`reextracted` events, or a column) and mark the invoice `extraction_failed`, rather than retrying forever?
4. **`received_at`:** is "time the API received it" right, or do you want the email's `Date` header (vendor-controlled, can be wrong) shown somewhere as well?
5. **pdf-lib:** OK for page counts only, or should T03 switch to `pdfjs-dist` (maintained, heavier) if it needs PDF parsing anyway?

## 9. `git diff --stat main...HEAD`

```
 .env.example                                                          |  53 +++-
 .prettierignore                                                       |   2 +-
 CLAUDE.md                                                             |  10 +-
 README.md                                                             |  59 +++--
 apps/api/package.json                                                 |   6 +-
 .../migrations/20261004110015_must_change_password/migration.sql      |   2 +
 apps/api/prisma/schema.prisma                                         |  19 +-
 apps/api/src/app.module.ts                                            |   8 +
 apps/api/src/app.setup.ts                                             |  16 ++
 apps/api/src/auth/auth.controller.ts                                  |   5 +-
 apps/api/src/auth/auth.module.ts                                      |   2 +
 apps/api/src/auth/auth.service.ts                                     |  10 +-
 apps/api/src/auth/bootstrap-admin.service.ts                          |  67 ++++++
 apps/api/src/auth/public.decorator.ts                                 |   8 +
 apps/api/src/auth/session.guard.ts                                    |  26 +-
 apps/api/src/auth/sessions.service.ts                                 |  10 +-
 apps/api/src/cli/create-admin.ts                                      |   8 +-
 apps/api/src/cli/simulate-mailgun.ts                                  | 195 +++++++++++++++
 apps/api/src/common/prisma-errors.ts                                  |   6 +
 apps/api/src/config/env.ts                                            |  33 ++-
 apps/api/src/extraction/extraction-queue.ts                           |  71 ++++++
 apps/api/src/extraction/extraction.handler.ts                         | 139 +++++++++++
 apps/api/src/extraction/extraction.module.ts                          |  30 +++
 apps/api/src/extraction/extraction.workers.ts                         |  42 ++++
 apps/api/src/extraction/invoice-extractor.ts                          |  20 ++
 apps/api/src/extraction/recovery-sweep.ts                             |  37 +++
 apps/api/src/extraction/stub-extractor.ts                             |  10 +
 apps/api/src/inbox/inbox.controller.ts                                |  28 +++
 apps/api/src/inbox/inbox.module.ts                                    |   9 +
 apps/api/src/inbox/inbox.service.ts                                   | 100 ++++++++
 apps/api/src/ingestion/files.ts                                       |  58 +++++
 apps/api/src/ingestion/ingestion.module.ts                            |  34 +++
 apps/api/src/ingestion/ingestion.service.ts                           | 202 ++++++++++++++++
 apps/api/src/ingestion/invoice-upload.controller.ts                   |  67 ++++++
 apps/api/src/ingestion/mailgun.controller.ts                          |  91 +++++++
 apps/api/src/ingestion/mailgun.ts                                     |  48 ++++
 apps/api/src/ingestion/uploaded-file.ts                               |  14 ++
 apps/api/src/invoices/content-disposition.ts                          |  12 +
 apps/api/src/invoices/invoice-files.controller.ts                     |  61 +++++
 apps/api/src/invoices/invoices.module.ts                              |   7 +
 apps/api/src/jobs/jobs.module.ts                                      |   9 +
 apps/api/src/jobs/jobs.service.ts                                     |  59 +++++
 apps/api/src/prisma/prisma.service.ts                                 |   8 +-
 apps/api/src/storage/storage.service.ts                               |  36 ++-
 apps/api/src/users/users.controller.ts                                |  14 +-
 apps/api/src/users/users.service.ts                                   |  42 +++-
 apps/api/test/auth.e2e.test.ts                                        |  13 +-
 apps/api/test/bootstrap-admin.e2e.test.ts                             | 124 ++++++++++
 apps/api/test/env.test.ts                                             |  61 ++++-
 apps/api/test/extraction.e2e.test.ts                                  | 168 +++++++++++++
 apps/api/test/global-setup.ts                                         |  41 +++-
 apps/api/test/guard.e2e.test.ts                                       |   5 +
 apps/api/test/helpers.ts                                              | 115 ++++++++-
 apps/api/test/inbox.e2e.test.ts                                       | 162 +++++++++++++
 apps/api/test/mailgun.e2e.test.ts                                     | 288 ++++++++++++++++++++++
 apps/api/test/password-change.e2e.test.ts                             | 164 +++++++++++++
 apps/api/test/upload.e2e.test.ts                                      | 126 ++++++++++
 apps/api/test/users.e2e.test.ts                                       |   1 +
 apps/web/src/components/change-password-dialog.tsx                    |  88 +------
 apps/web/src/components/change-password-form.tsx                      |  53 ++++
 apps/web/src/components/invoice-status-badge.tsx                      |  40 ++++
 apps/web/src/components/require-auth.tsx                              |   8 +-
 apps/web/src/components/ui/sheet.tsx                                  | 128 ++++++++++
 apps/web/src/components/upload-invoices-dialog.tsx                    | 244 +++++++++++++++++++
 apps/web/src/lib/api.ts                                               |  19 +-
 apps/web/src/lib/change-password.ts                                   |  48 ++++
 apps/web/src/lib/format.ts                                            |   6 +
 apps/web/src/lib/query-client.ts                                      |  18 +-
 apps/web/src/pages/inbox/email-sheet.tsx                              | 115 +++++++++
 apps/web/src/pages/inbox/inbox-page.tsx                               | 152 ++++++++++++
 apps/web/src/pages/inbox/inbox-query.ts                               |  42 ++++
 apps/web/src/pages/inbox/invoice-chip.tsx                             |  27 +++
 apps/web/src/pages/placeholder-page.tsx                               |   2 +-
 apps/web/src/pages/set-password-page.tsx                              |  75 ++++++
 apps/web/src/pages/users/add-user-dialog.tsx                          |   2 +-
 apps/web/src/pages/users/reset-password-dialog.tsx                    |  86 +++++++
 apps/web/src/pages/users/users-page.tsx                               |  61 +++--
 apps/web/src/pages/users/users-query.ts                               |  16 +-
 apps/web/src/router.tsx                                               |  11 +-
 apps/web/vite.config.ts                                               |   6 +-
 docker-compose.yml                                                    |  10 +-
 docs/SPEC.md                                                          |   5 +-
 docs/reports/T02-ingestion.md                                         | 412 ++++++++++++++++++++++++++++++++
 .../invoices/AEG-10454-INV-3110713.PDF => fixtures/invoices/aeg.pdf   | Bin
 docs/fixtures/invoices/SI-000218719.pdf => fixtures/invoices/asm.pdf  | Bin
 .../invoices/petrocas.pdf                                             | Bin
 package.json                                                          |   3 +-
 packages/shared/src/auth.ts                                           |  25 +-
 packages/shared/src/inbound.ts                                        |  57 +++++
 packages/shared/src/inbox.ts                                          |  59 +++++
 packages/shared/src/index.ts                                          |   3 +
 packages/shared/src/invoices.ts                                       |  33 +++
 packages/shared/src/users.ts                                          |   5 +
 pnpm-lock.yaml                                                        | 126 +++++++++-
 94 files changed, 4838 insertions(+), 208 deletions(-)
```
