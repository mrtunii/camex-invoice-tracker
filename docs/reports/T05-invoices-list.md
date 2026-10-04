# T05 — Invoices list (+ T07 follow-ups)

Branch `t05-invoices-list`, one commit "T05: invoices list". Not merged, not pushed.

## 0. Git (§0)

`main` already contained T07 and matched `origin/main` (both at `056116d`), so every step was a no-op. Commands as run, with their output:

| Command                             | Output                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `git checkout main`                 | `Already on 'main'` · `Your branch is up to date with 'origin/main'.` |
| `git pull --ff-only`                | `Already up to date.`                                                 |
| `git merge --ff-only t07-deploy`    | `Already up to date.`                                                 |
| `git push origin main`              | `Everything up-to-date`                                               |
| `git checkout -b t05-invoices-list` | `Switched to a new branch 't05-invoices-list'`                        |

The only untracked file before branching was `docs/tasks/T05-invoices-list.md`; it is committed with T05.

## 1. Summary

- **API:** `GET /api/invoices` (tabs, search, filters, six sort keys, stable pages, `dueState`), `GET /api/invoices/summary` (tab counts, unpaid totals per currency summed in SQL, overdue / next-7-days counts) and `GET /api/invoices/export.csv` (UTF-8 with BOM, RFC 4180, CSV-injection prefix, 10,000-row cap). All query parameters are validated by strict zod schemas in `packages/shared/src/invoice-list.ts`.
- **Web:** `/invoices` with the whole state in the URL: tabs with counts, summary strip with links, filters, sortable columns, pagination, Export CSV, Upload PDFs, 5 s refetch while a visible row is processing, loading / empty / error states. Row click or Enter opens an interim `/invoices/:id` page (number, vendor, status, Open PDF). `lib/format.ts` formats money from decimal strings without a JS number (13 Node unit tests).
- **T07 follow-ups:** the Inbox table no longer overflows at 1280 px; the runbook has the bucket-lock and Mailgun decisions; the branch rule is in SPEC §14 and CLAUDE.md.
- **Found and fixed a flaky-test cause** in the shared test helper (§3): about 1 run in 4 of the new suite failed with a random 403 or "socket hang up". After the fix: 10/10 clean runs.
- **Verified:** `pnpm test` (API 309/309 in 26 files, web 13/13), lint, typecheck and build, both in the working tree and in a clean clone. The "Done when" data check used real extraction of the three fixtures plus four uploads, with statuses set in the DB, driven in headless Chromium at 1280 px and 390 px.
- **Not verified by me:** opening the CSV in Numbers or Excel (§7). The file's bytes are checked (BOM, valid UTF-8, Georgian intact), but the AppleScript call to Numbers hung, probably on a macOS automation-permission prompt. Please open one export once.
- **No new dependencies.**

## 2. What was built

### T07 follow-ups (§0b)

| #   | Decision                                           | Change                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | API image size accepted                            | none                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Mailgun signing key shared for now                 | `docs/deploy.md` §8 "Production later": the key is per account, shared by staging and production for now; a Mailgun **subaccount** isolates it later.                                                                                                                                                                                                                                      |
| 3   | R2 checksums stay `WHEN_REQUIRED`                  | none                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Postgres TLS default stays                         | none                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | R2 lock: none on staging, indefinite in production | `docs/deploy.md` §0 and §7 checklist, SPEC §12.                                                                                                                                                                                                                                                                                                                                            |
| 6   | Inbox overflow at 1280 px                          | `inbox-page.tsx`: fixed table layout with column widths. From, subject, file names and ignored attachments truncate through a new `TruncatedText`, which shows a tooltip only when the text is actually cut. Measured: table 1027 px in a 958 px card before, 958 in 958 after. Cause: `max-w-*` on table cells has no effect in automatic table layout, so long values widened the table. |

### API (§1)

- `packages/shared/src/invoice-list.ts`: query schemas (`z.strictObject`, so unknown parameters are refused) for the list, summary (no status/sort/page) and export (no page), plus the response schemas, the default sorts and constants (page size 50 / max 200, 10,000-row cap, 3 / 7 days). `validCalendarDateSchema` refuses impossible dates like `2026-02-30`. `dates.ts` gains `dateUrgency()` (passed / soon), used for `dueState` and the dispute-deadline colours.
- `apps/api/src/invoices/invoice-query.ts`: one SQL builder for all three endpoints, so a filter means the same thing everywhere.
  - FROM `invoices` ⋈ `inbound_emails` (received_at), LEFT JOIN `vendors`.
  - Search: `ILIKE` over the extracted vendor name, the linked vendor's name, invoice number, registration, and each flight number (`EXISTS … unnest(flight_numbers)`). `%`, `_` and `\` in the search are escaped.
  - `hasErrors`: `flags @> '[{"severity":"error"}]'`. `due`: unpaid and before today / today … today+7, both from `businessToday(clock)`.
  - ORDER BY the key `NULLS LAST` (both directions), then `received_at`, then `id`, in the same direction.
  - Values are always bound parameters; only fixed SQL fragments from lookup tables are interpolated.
- `invoice-list.service.ts`:
  - **List:** count and ordered page ids (two statements), then hydrate the page with Prisma. `dueState` is computed only for `unpaid` rows.
  - **Summary:** one `count(*) FILTER (…)` query, plus `sum(amount_due)` grouped by `amount_due_currency` in numeric (exact) arithmetic. `trim_scale` drops the trailing zeros, like every other decimal in the API.
  - **CSV:** fetches at most 10,001 ids; at 10,001 it answers 400 "More than 10,000 invoices match. Narrow the filter to export them."
- `invoice-csv.ts`: RFC 4180 fields, BOM, CRLF. A cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`, except amount cells that are plain decimals.
- `invoices.controller.ts`: the three routes are declared before `:id`. The export sets `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="invoices-<status>-<YYYY-MM-DD>.csv"` and `Cache-Control: private, no-store`.
- `app.setup.ts`: CORS exposes `Content-Disposition`, so the SPA (on another host) can read the export's filename.

### Web (§2)

- `pages/invoices/list-params.ts`: URL ↔ state.
  - Parameter names are the API's. Defaults are omitted (Needs review, page 1, default sort), and invalid values in a hand-edited URL are ignored instead of failing.
  - It builds the list, summary and export API paths. Search is sent only from 2 characters.
- `invoices-page.tsx`: tabs (links with counts), summary strip, filters, table, pagination, Export CSV (fetch + blob, toast on error), Upload PDFs (refetches the list, summary and Inbox after upload).
- `invoice-filters.tsx`:
  - Search (debounced 300 ms; replaces the history entry).
  - Searchable vendor select (from `/api/vendors`) and category select.
  - Searchable currency select (ISO codes from the browser; GEL, USD, EUR first; matches code or name, e.g. "lari").
  - Invoice date range (native date inputs, min/max cross-linked), Has errors toggle, a removable "Overdue" / "Due in 7 days" chip, and Clear filters.
- `invoices-table.tsx`: the spec's columns, plus "Dispute by" on Needs review and "Paid on" on Paid.
  - Due dates are red when overdue and amber when due soon, with a screen-reader label; a dotted "derived" hint with a tooltip for `terms` / `vendor_default`.
  - Vendor: the linked vendor's name, or the extracted name with a "New" badge. "Processing…" badge while processing; "Extraction failed" when it did.
  - Sortable headers (`aria-sort`). Rows are focusable; Enter opens them.
  - Fixed layout: vendor names wrap to two lines; other long values truncate with a tooltip. Below about 944 px the table scrolls inside its card.
- `pagination.tsx`: "51–100 of 121" and page links (1 … 4 5 [6] 7 8 … 20). They are real links, so back/forward works.
- `invoice-page.tsx`: the interim detail page. Its back link returns to the exact list URL the row was opened from.
- `components/combobox.tsx` (Popover + listbox, keyboard navigation), `components/truncated-text.tsx`, `components/ui/popover.tsx` (generated by the repo's shadcn CLI; `radix-ui` was already a dependency), `lib/invoice-labels.ts`.
- `lib/format.ts`:
  - `formatMoney` uses `Intl.NumberFormat.format(string)`, which formats a numeric string exactly (ES2023). Minimum 2 decimals, maximum = the string's own scale, so nothing is rounded.
  - `formatDate` uses a fixed month table, because `en-GB` prints September as "Sept" in current ICU and the spec wants "16 Sep 2026".
  - `formatTimestamp` is built on the same parts (Tbilisi).
- `lib/api.ts`: `apiDownload()`.
- Removed the now-unused `PlaceholderPage`.

### Tests (§3)

- `apps/api/test/invoice-list.e2e.test.ts`: 25 tests (list in §6). Rows are seeded directly with Prisma (any status, dates, amounts, flags); one test uses the real ingestion + extraction path. The clock is injected (`setToday`).
- `apps/web/src/lib/format.test.ts`: 13 Node test-runner tests. `pnpm --filter @camex/web test` now runs `docker/*.test.ts` and `src/**/*.test.ts`. The web tsconfig allows `.ts` import extensions for that (`noEmit` is already on).
- `apps/api/test/cors.e2e.test.ts`: expects the new `Access-Control-Expose-Headers`.

### Docs

SPEC §10 (sorts, filters, URL state, endpoints), §12 (bucket lock), §14 and CLAUDE.md (branch rule as given), README ("Invoices list"), `docs/deploy.md` (§0b items 2 and 5).

## 3. Deviations (with reasons)

- **`apps/api/test/helpers.ts` changed (outside T05's scope).** `createTestApp` now calls `app.listen(0, '127.0.0.1')` instead of `app.init()`.
  - **Symptom:** about 1 run in 4 of the new suite failed: a GET answered 403, or the socket hung up.
  - **Cause:** with an unbound server, supertest binds an ephemeral port on `::` for each request but connects to `127.0.0.1:<port>`. macOS lets that port be held separately on `127.0.0.1` by another program, and this machine has five such listeners in the ephemeral range (Logi, OrbStack, DBeaver).
  - **Proof:** I bound Node on `::` at DBeaver's port, and a request to `127.0.0.1` there got DBeaver's `403 Not authorized`.
  - **After the fix:** 10/10 clean runs of the suite, and the full suite passes. Existing tests were simply lucky with fewer requests.
- **Inbox ignored attachments** no longer carry the content type in a hover title; the name truncates with a tooltip like the other cells. The type is still in the email sheet.
- **Timestamps everywhere** now say "Sep" instead of ICU's "Sept" for September (shared `formatTimestamp`); otherwise the format is unchanged.

## 4. Decisions not in the spec

1. **"Received"** is `inbound_emails.received_at` (when the email or upload arrived), exposed as `receivedAt`.
2. **Sorting:**
   - Nulls last in both directions. Ties break by received, then id, in the key's direction, which makes it a total order.
   - `sort` without `order` uses the key's natural direction: deadlines and due dates soonest first; received, invoice date, amount and paid date newest or largest first. The UI uses the same table for a header's first click.
   - `order` alone flips the tab's default.
   - The amount sort compares amounts across currencies as plain numbers (no FX).
3. **`due` is a filter like the others:** it narrows the list, the tab counts and the summary. So after clicking "2 overdue", the strip reads "2 overdue · 0 due in 7 days" (Q2). Tab changes keep the filters and reset sort and page.
4. **Validation:**
   - `hasErrors=false` means no filter. `currency` is accepted in any case.
   - A reversed date range or an impossible date is 400, and so is `q` longer than 200 characters.
   - A repeated parameter (`status=a&status=b`) is 400.
5. **CSV details:**
   - `vendor` is the linked vendor's name, else the extracted one. `airport` is IATA, else the location text (the list's Location rule). `status` is the raw value.
   - The filename uses the requested tab and the Tbilisi business day.
   - The `'` prefix is applied to every non-amount cell (ids and dates never start with those characters).
6. **Summary totals** are sorted by currency as specified, so the strip reads "GEL 88,753.98 · USD 22,079.08" (the task's example lists USD first).
7. **All tab:** a status badge under the vendor name. The spec's columns have no status, and the All tab would otherwise not show it. "Processing…" shows wherever processing rows appear (Needs review and All).
8. **Export is a fetch + blob download, not a link,** so the 10,000-row 400 becomes a toast instead of a JSON page. This needs the CORS expose header (§2).
9. **Interim detail page** also shows the amount due and the file name.
10. **Column order:** Dispute by after Due date; Paid on after Amount due. Header "Dispute by".

## 5. How to verify (from a clean clone)

Prerequisites: Node 24+, pnpm 9+, Docker. An Anthropic key only for step 3.

```sh
git clone <repo-url> camex && cd camex && git checkout t05-invoices-list
cp .env.example .env              # set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ chars)
pnpm install --frozen-lockfile
docker compose up -d --wait       # Postgres :55432, MinIO :59000/:59001, healthy
pnpm db:migrate                   # "All migrations have been successfully applied."
pnpm test                         # api: 26 files, 309 tests passed (~100 s); web: 13 tests pass
pnpm lint && pnpm typecheck && pnpm build    # all clean (Vite's old chunk-size warning, §7)
pnpm dev                          # API :3180, web http://localhost:5180
```

1. Sign in (set a new password). `/` goes to `/invoices`, which shows "Nothing to review…" and zero counts in every tab. The sidebar order is Invoices, Inbox, Vendors, Users.
2. `pnpm simulate:mailgun`. With the stub extractor, three rows appear with "Processing…" and turn into extracted rows within a few seconds, without a reload.
3. **"Done when" data.** In `.env` set `EXTRACTOR_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, restart `pnpm dev`, and start from an empty database (in the clone, which has its own compose volumes: `docker compose down -v && docker compose up -d --wait && pnpm db:migrate`). Each extraction costs about $0.02.
   1. Run `pnpm simulate:mailgun`.
   2. Make four upload copies of the fixtures:
      ```sh
      for f in asm:m1 petrocas:m2 aeg:m3 aeg:m4; do n=${f%%:*}; t=${f##*:}; { cat fixtures/invoices/$n.pdf; printf '\n%% variant %s\n' $t; } > /tmp/$n-$t.pdf; done
      ```
   3. Upload those four with **Upload PDFs** on `/invoices`.
   4. When nothing is processing, set the states:
      ```sh
      docker compose exec -T postgres psql -U camex -d camex <<'SQL'
      UPDATE invoices SET status = 'unpaid', approved_at = now() WHERE file_name IN ('asm.pdf', 'aeg.pdf');
      UPDATE invoices SET status = 'unpaid', approved_at = now(), due_date = (now() AT TIME ZONE 'Asia/Tbilisi')::date + 2, due_date_source = 'vendor_default' WHERE file_name = 'petrocas.pdf';
      UPDATE invoices SET status = 'unpaid', approved_at = now(), amount_due = NULL, due_date = (now() AT TIME ZONE 'Asia/Tbilisi')::date + 5 WHERE file_name = 'aeg-m4.pdf';
      UPDATE invoices SET status = 'paid', paid_at = '2026-10-01', payment_reference = 'TRX-1001' WHERE file_name = 'asm-m1.pdf';
      UPDATE invoices SET status = 'rejected', rejected_at = now(), rejection_reason = 'duplicate', vendor_name = 'შპს პეტროკასი ენერჯი' WHERE file_name = 'petrocas-m2.pdf';
      SQL
      ```
   5. Expected:
      - Tabs: Needs review 1 · Unpaid 4 · Paid 1 · Rejected 1 · All 7.
      - Strip: "Unpaid GEL 88,753.98 · USD 22,079.08 + 1 without amount · 2 overdue · 2 due in 7 days".
      - Unpaid tab: asm and aeg due dates red; petrocas amber with "derived"; aeg-m4's amount "—".
      - "2 overdue" opens Unpaid with `due=overdue` (2 rows, removable "Overdue" chip).
      - Searching `petro` finds the Latin name only; `პეტრო` finds the Georgian one.
      - Export CSV on All gives `invoices-all-<today>.csv`: 7 rows plus the header, starting with bytes `EF BB BF`. Open it in Numbers or Excel: the rejected row's vendor reads შპს პეტროკასი ენერჯი.
4. Check the layout at 1280 px and 390 px. The page never scrolls sideways; at 390 px the table scrolls inside its card. Check `/inbox` at 1280 px too: every column is visible, and long values show "…" with a tooltip on hover.

**What I actually ran**

- **Working tree:** `pnpm test` (309 + 13), lint, typecheck, build.
- **UI and "Done when" check:** run against the separate compose project `camex-invoices-check` (Postgres 56432, MinIO 60000, API 3181, Vite 5181), with the dev stack untouched.
  - Data: an admin created with `pnpm create-admin`, `simulate:mailgun` and four uploads with real Anthropic extraction (7 calls), then the SQL above with fixed dates for 2026-10-04. The summary API returned exactly `counts 1/4/1/1/7`, `GEL 88753.98`, `USD 22079.08`, `unpaidWithoutAmount 1`, `overdue 2`, `dueNext7 2`.
  - Browser: headless Chromium (playwright-core from an earlier session's scratchpad, not committed) drove every flow in §6, including one more upload through the dialog (an eighth extraction). Total spend was about $0.16 at the README's per-invoice estimate.
  - Pagination: 120 rows were inserted temporarily and deleted afterwards.
- **Clean clone of `485dcfd`** (this commit without the report), in a temp directory as `camex-invoices-check` with fresh volumes:
  - `pnpm install --frozen-lockfile`, `up -d --wait`, `db:migrate`, `pnpm test` (309/309, 98 s; web 13/13), lint, typecheck 3/3, build 3/3.
  - Then the built API (`NODE_ENV=production pnpm start`) and `vite preview`. The bootstrap admin's first login and set-password led to `/invoices`. The empty states showed per tab (with the inbox address when configured). `simulate:mailgun` (stub) rows finished "Processing…" on screen after about 5 s, and Export CSV downloaded `invoices-needs_review-2026-10-04.csv`.
  - Both servers were stopped by process group and the check project was torn down with its volumes.

## 6. Test results

```
$ pnpm test
apps/web test: ℹ tests 13 · ℹ pass 13 · ℹ fail 0
apps/api test:  Test Files  26 passed (26)
apps/api test:       Tests  309 passed (309)      (284 before T05: +25)
$ pnpm lint        → eslint clean, "All matched files use Prettier code style!"
$ pnpm typecheck   → shared, api, web: Done
$ pnpm build       → shared, api, web: Done
```

New API suite (`vitest run test/invoice-list.e2e.test.ts`, 25 passed):

- access and validation: requires a session (401) · refuses bad and unknown parameters (400; 22 cases) · the summary takes no status, sort or page; the export takes no page
- list: item shape and defaults · status tabs (needs_review default, includes processing) · a real ingested PDF while processing and after extraction
- search: each field as a case-insensitive substring (extracted name, linked vendor name, invoice #, registration, second flight number, trimmed) · Georgian, including capital Mtavruli letters · other fields not searched; `%` and `_` literal · combined with filters
- filters: vendor, category, currency (any case), date range inclusive, has errors, combinations
- `dueState` and `due=overdue|soon` with the injected business day, boundaries moving with the clock
- sorting: every key in both orders with nulls last · the default direction per key; `order` alone flips the default · the default sort per status · stable pages (23 rows with equal received_at and few distinct keys, paged by 5 for four sorts: no duplicates or gaps; past the end → `items: []`)
- summary: counts, exact totals (`0.1 + 0.2 = "0.3"`, `88753.98 + 0.02 = "88754"`, a negative EUR total), without-amount count · overdue / next 7 days with the clock and filters · search and filters narrow the counts
- CSV: BOM, CRLF, header, content type, filename, no-store · every column (decimal `12345678901234.5678` as stored, dates, UTC timestamps, lists, the first WEB_ORIGINS URL) · quoting of commas, quotes and newlines; a Georgian round trip at byte level · formula prefixes (`=`, `+`, `-`, `@`, tab, CR) with negative amounts left numeric · same filters and sort as the list · 10,000 rows OK, 10,001 → 400, and a summary over the 10,001 rows sums exactly (`15001.5`)

Mutation checks (temporary, reverted): removing the LIKE escaping fails the wildcard test; replacing the `id` tie-breaker and dropping `NULLS LAST` fails 4 sorting tests.

UI (headless Chromium):

| Check                             | 1280 px                | 390 px                               |
| --------------------------------- | ---------------------- | ------------------------------------ |
| Page horizontal overflow (5 tabs) | none (1280/1280)       | none (390/390)                       |
| Invoices table vs its card        | 958/958 on every tab   | scrolls inside the card (944 in 356) |
| Content sticking out of a cell    | none                   | none                                 |
| Inbox table vs its card           | 958/958 (was 1027/958) | scrolls inside the card              |

Flows checked:

- `/` → `/invoices`; sidebar order.
- Search: 1 character shows a hint and is not applied; `petro`, `პეტრო` and `cms624` filter, and the tab counts follow.
- Vendor select by typing + Enter, and clearing it. Category with no match → "No invoices match these filters" + Clear. Currency by name ("lari" → GEL). Date from; Has errors (`aria-pressed`).
- Back, forward and reload restore the URL and the controls. Clear filters.
- Amount sort desc then asc (numeric order, nulls last).
- Overdue and due-in-7-days links.
- Row click and Enter open the detail page; its back link returns to the same list URL; Open PDF answers 200 `application/pdf`.
- Export on All: filename, BOM, 7 rows, Georgian.
- Skeleton rows while loading; the error alert with Try again.
- Pagination across 121 rows (1–50, 51–100, 101–121, back; a filter change resets to page 1; page 9 → "past the end").
- Upload through the dialog: the row appears as "Processing…", 2 list refetches in 10 s, then none once nothing is processing.
- Truncation tooltips appear only when the text is cut.

The only browser console errors were the expected pre-login `401` and the injected 500s.

## 7. Known issues / shortcuts

- **CSV in Numbers / Excel not verified by me.** The bytes are checked (BOM `EF BB BF`, valid UTF-8, the Georgian vendor present). I tried Numbers via AppleScript and it hung, probably on a macOS "allow automation" prompt or a first-launch dialog. I stopped the Numbers process I had started. There is no Excel or LibreOffice on this machine.
- **Georgian case-insensitivity depends on the database locale.** `ILIKE` uses the database's ctype. The local Postgres 16 (Alpine, en_US.utf8) folds Mtavruli to Mkhedruli, and a test covers it. The hosted provider's locale is unknown (Q4).
- **Count and page are two statements,** not one snapshot. Under concurrent writes, `total` can be off by a row for a moment.
- **The vendor filter loads every vendor** (`/api/vendors` has no pagination). Fine for a registry this size.
- **The CSV is built in memory** (10,000 rows is about 3 MB).
- **Tooltips on truncated cells are hover-only.** Screen readers get the full text, and keyboard users can open the row. A 1-character search stays in the URL but isn't applied (a hint says so).
- **Web bundle:** one 759 kB chunk (233 kB gzip). Vite's chunk-size warning dates from T01 (648 kB then).

## 8. Questions for the CTO

1. **"Due in 7 days" vs "soon" (3 days).** The strip's link (`due=soon`) covers 7 days, but SPEC §6 colours only 3 days amber, so rows due in 4–7 days show uncoloured on that page. Keep it, or mark 4–7 days too?
2. **Should the strip's overdue / next-7-days counts ignore an active `due` filter?** Now they follow all filters, as specified, so after "2 overdue" the other link reads "0 due in 7 days".
3. **All tab status badge** (decision 7): keep, or add a proper Status column?
4. **Hosted Postgres locale:** once the provider is chosen, can I check Georgian case folding there with one query (`SELECT lower('ᲙᲐᲛᲔᲥᲡ')` should give `კამექს`)?
5. Could you open one export in Excel (and/or Numbers) to confirm the Georgian text? Or allow Terminal to control Numbers, and I'll script it.

## 9. `git diff --stat main...HEAD`

```
 CLAUDE.md                                       |   1 +
 README.md                                       |   4 +
 apps/api/src/app.setup.ts                       |   2 +
 apps/api/src/invoices/invoice-csv.ts            |  38 ++
 apps/api/src/invoices/invoice-list.service.ts   | 308 ++++++++++++++
 apps/api/src/invoices/invoice-query.ts          | 130 ++++++
 apps/api/src/invoices/invoices.controller.ts    |  53 ++-
 apps/api/src/invoices/invoices.module.ts        |   3 +-
 apps/api/test/cors.e2e.test.ts                  |   3 +
 apps/api/test/helpers.ts                        |   5 +-
 apps/api/test/invoice-list.e2e.test.ts          | 965 ++++++++++++++++++++++++++++++++++++++++++++
 apps/web/package.json                           |   2 +-
 apps/web/src/components/combobox.tsx            | 172 ++++++++
 apps/web/src/components/truncated-text.tsx      |  49 +++
 apps/web/src/components/ui/popover.tsx          |  71 ++++
 apps/web/src/lib/api.ts                         |  50 ++-
 apps/web/src/lib/format.test.ts                 |  60 +++
 apps/web/src/lib/format.ts                      |  73 +++-
 apps/web/src/lib/invoice-labels.ts              |  12 +
 apps/web/src/pages/inbox/inbox-page.tsx         |  40 +-
 apps/web/src/pages/inbox/invoice-chip.tsx       |   5 +-
 apps/web/src/pages/invoices/invoice-filters.tsx | 194 +++++++++
 apps/web/src/pages/invoices/invoice-page.tsx    |  88 ++++
 apps/web/src/pages/invoices/invoices-page.tsx   | 287 +++++++++++++
 apps/web/src/pages/invoices/invoices-query.ts   |  62 +++
 apps/web/src/pages/invoices/invoices-table.tsx  | 420 +++++++++++++++++++
 apps/web/src/pages/invoices/list-params.ts      | 155 +++++++
 apps/web/src/pages/invoices/pagination.tsx      |  85 ++++
 apps/web/src/pages/placeholder-page.tsx         |  14 -
 apps/web/src/router.tsx                         |  13 +-
 apps/web/tsconfig.json                          |   2 +
 docs/SPEC.md                                    |   9 +-
 docs/deploy.md                                  |   6 +-
 docs/reports/T05-invoices-list.md               | 294 ++++++++++++++
 docs/tasks/T05-invoices-list.md                 | 149 +++++++
 packages/shared/src/dates.ts                    |  10 +
 packages/shared/src/index.ts                    |   1 +
 packages/shared/src/invoice-list.ts             | 196 +++++++++
 38 files changed, 3963 insertions(+), 68 deletions(-)
```
