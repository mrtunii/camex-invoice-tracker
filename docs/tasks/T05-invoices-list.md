# T05 — Invoices list

You are implementing task T05 of the Camex Invoice Tracker. Read CLAUDE.md, docs/SPEC.md (§6, §8, §10) and this file before writing code.

## 0. Git: merge the accepted T07 first

The CTO has reviewed and accepted `t07-deploy`. Otto may already have merged and pushed it. Make sure `main` contains it and is pushed:

```sh
git checkout main
git pull --ff-only
git merge --ff-only t07-deploy      # no-op if already merged
git push origin main                # no-op if already pushed
```

- If any step fails (not fast-forward, push rejected, auth or SSH error), stop and ask. Never force-push, rebase, reset `main` or create merge commits.
- Only `docs/tasks/T05-invoices-list.md` (CTO-provided) may be untracked. Any other uncommitted change → stop and ask.
- Create branch `t05-invoices-list`. Commit this file as part of T05. One commit "T05: invoices list". Don't merge or push T05 itself.
- **Report** the exact `git` commands you ran in §0 and their output (one line each).

**SPEC §14 and CLAUDE.md:** replace the branch rule with "Each task runs on branch tNN-<slug> and ends with one commit. The CTO reviews it; the next task's prompt begins by fast-forward merging the accepted branch into main and pushing. Never merge or push your own task branch; never reset or force-move main."

## 0b. T07 follow-ups (CTO decisions on the T07 questions)

1. **API image size:** accepted as is.
2. **Mailgun signing key:** shared across environments for now. Runbook "Production later": mention a Mailgun subaccount as the way to isolate it.
3. **R2 checksums:** keep `WHEN_REQUIRED`.
4. **Postgres TLS:** keep the runbook default until Otto names the provider.
5. **R2 bucket lock:** no lock on staging; indefinite lock in production. Update the runbook.
6. **Inbox table overflow at 1280 px** (found in T07): fix it. Long values truncate with a tooltip; nothing overflows its card.

## 1. API

### `GET /api/invoices`

**Query parameters**, validated with a zod schema in `packages/shared`. Unknown parameters → 400.

| Param | Meaning |
|---|---|
| `status` | `needs_review` (also includes `processing`), `unpaid`, `paid`, `rejected`, `all`. Default `needs_review`. |
| `q` | search, trimmed, min 2 chars. Case-insensitive substring over the extracted vendor name, the linked vendor's name, invoice number, aircraft registration and each flight number. |
| `vendorId` | uuid |
| `category` | one of the SPEC categories |
| `currency` | ISO code; filters `amount_due_currency` |
| `invoiceDateFrom`, `invoiceDateTo` | `YYYY-MM-DD`, inclusive |
| `hasErrors` | `true` → only invoices with at least one error-severity flag |
| `due` | `overdue` (unpaid, due date < today) or `soon` (unpaid, due date within today…today+7). Used by the summary strip links. |
| `sort` | `received`, `invoiceDate`, `dueDate`, `disputeDeadline`, `amountDue`, `paidAt` |
| `order` | `asc` / `desc` |
| `page` (1-based), `pageSize` (default 50, max 200) | pagination |

**Default sort per status** (when `sort` is absent):

| Status | Sort |
|---|---|
| needs_review | disputeDeadline asc, nulls last, then received asc |
| unpaid | dueDate asc, nulls last |
| paid | paidAt desc |
| rejected, all | received desc |

Every sort ends with `id` as the tie-breaker, so pages are stable.

**Response** `{ items, total, page, pageSize }`. Each item:
- id, status, extractionStatus, receivedAt;
- vendor (`{id, name}` or null), vendorName (extracted);
- invoiceNumber, invoiceDate, dueDate, dueDateSource, disputeDeadline;
- amountDue, amountDueCurrency, category, airportIata, locationText;
- flags (code + severity), paidAt;
- `dueState`: `overdue | soon | null`. Computed server-side for `unpaid` with `businessToday`: overdue if due < today, soon if due within today…today+3 (SPEC §6).

### `GET /api/invoices/summary`

Same filters as the list, except `status`, `sort` and pagination. Returns:
- `counts`: `{ needs_review (incl. processing), unpaid, paid, rejected, all }`;
- `unpaidTotals`: `[{ currency, amount }]`, the sum of `amount_due` grouped by `amount_due_currency`, computed in SQL, amounts as strings, sorted by currency. Invoices without an amount or currency are counted separately as `unpaidWithoutAmount`;
- `overdueCount`, `dueNext7Count` (unpaid only).

### `GET /api/invoices/export.csv`

Same filters and sort as the list (including `status`), no pagination, capped at 10,000 rows (more → 400 asking to narrow the filter).
- **Encoding:** UTF-8 with BOM (Excel must show Georgian text correctly). Comma-separated, RFC 4180 quoting, CRLF line ends. `Content-Disposition: attachment; filename="invoices-<status>-<YYYY-MM-DD>.csv"`.
- **Columns:** id, status, received_at, vendor, invoice_number, invoice_date, due_date, dispute_deadline, amount_due, amount_due_currency, total_amount, currency, category, description, airport, aircraft_registration, flight_numbers (space-separated), flags (codes, space-separated), approved_at, paid_at, payment_reference, url (`<first WEB_ORIGINS entry>/invoices/<id>`).
- **Values:** decimals exactly as stored, never floats; dates `YYYY-MM-DD`; timestamps ISO in UTC.
- **CSV injection:** vendor-controlled text goes into Excel. Any cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. Amounts are exempt only when they match the decimal regex (negative credit notes stay numeric).

## 2. Web

**Navigation:** `/` redirects to `/invoices`. Sidebar order: Invoices, Inbox, Vendors, Users.

**`/invoices`**
- **URL state:** tab, filters, sort and page live in the query string, so links, back/forward and reloads keep them.
- **Status tabs with counts** from the summary.
- **Summary strip:**
  - unpaid totals per currency, e.g. "USD 22,079.08 · GEL 88,753.98", never converted or added together;
  - "N overdue" and "N due in 7 days". Each one links to the Unpaid tab with `due=overdue` / `due=soon`;
  - "+ N without amount" when that count isn't zero.
- **Filters row:** search (debounced), vendor select (searchable, from `/api/vendors`), category, currency, invoice date range, "Has errors" toggle, "Clear filters".
- **Buttons:** "Export CSV" (current tab, filters and sort) and "Upload PDFs" (reuse `UploadInvoicesDialog`; refetch after upload).
- **Table columns:**

  | Column | Content |
  |---|---|
  | Received | date + time, Tbilisi |
  | Vendor | linked vendor's name; otherwise the extracted name with a small "New" badge |
  | Invoice # | |
  | Invoice date | |
  | Due date | red when `overdue`, amber when `soon`; a small "derived" hint when the source is `terms` or `vendor_default` |
  | Amount due | right-aligned, tabular numbers, with currency |
  | Category | |
  | Location | IATA, else location text |
  | Flags | `FlagCounts` |

  - Needs review tab: a "Processing…" badge in the vendor cell while processing, plus a dispute-deadline column (red when passed, amber within 3 days).
  - Paid tab: a "Paid on" column.
- **Sortable column headers** for the sort keys above.
- **Row click** (and Enter on a focused row) → `/invoices/:id`. Until T06 that route renders a simple page with the invoice number, vendor, status and an "Open PDF" link; T06 replaces it.
- **Refetch** every 5 s while any visible row is processing.
- **States:** empty (per tab, with the inbox address if configured), loading skeleton, error.
- **Pagination:** page numbers with total.

**Formatting (shared `lib/format.ts`)**
- Money: format the decimal string without converting to a JS number. `Intl.NumberFormat` accepts strings; check that precision survives, e.g. `"12345678901234.5678"`. Thousands separators, at least 2 decimals, the stored precision beyond that.
- Dates: "16 Sep 2026".

## 3. Tests

**API**
- each filter alone and combined; search across all five fields (case-insensitive, Georgian text);
- every sort key, both orders, nulls last, stable pagination (no duplicates or gaps across pages);
- default sorts per status; `processing` included in `needs_review`;
- `dueState` and `due=overdue|soon`, with the injected clock;
- summary: counts respect filters; unpaid totals per currency are exact decimal sums (e.g. `0.1 + 0.2 = 0.3`); `unpaidWithoutAmount`;
- CSV: BOM, header, quoting of commas, quotes and newlines, Georgian round-trip, formula-injection prefixing (and negative amounts left alone), the 10,000-row cap, filename;
- 401 without a session; 400 for bad params.

**Web:** unit tests for the money formatter (Node test runner, as in T07). Check the UI with a Playwright script outside the repo, as before, including a 1280 px and a 390 px width.

## Out of scope

The detail split view and actions (T06), bulk actions, saved filters, FX conversion.

## Done when

- With the three fixture invoices plus a few manually uploaded ones in various states (set statuses directly in the DB for the check), the tabs, counts, totals, filters, sorting and CSV all behave as specified.
- The CSV opens in Excel / Numbers with Georgian text intact.

## Report

`docs/reports/T05-invoices-list.md` with the sections from CLAUDE.md, the §0 git log, and `git diff --stat main...HEAD`. Don't claim anything works unless you ran it.
