# Camex Invoice Tracker — Spec v0.1

Status: draft · 2026-10-02 · Source of truth for all implementation tasks. Changes come from the CTO.

## 1. What this is

An internal tool for Camex Airlines finance. Vendors email invoices (PDF) to one address. The system stores the email and the PDF, extracts structured data with an LLM, and a human checks each invoice against the original before it becomes payable. It is then tracked until paid.

`email arrives → PDF extracted → human reviews against original → unpaid → paid`

### In scope (v1)
- Login for a small set of admin users. No signup, no roles.
- Inbound email via Mailgun to one address. PDF attachments only.
- Manual PDF upload (same pipeline as email).
- LLM extraction into a fixed schema; raw model output kept.
- Deterministic validation flags (arithmetic, dates, duplicates, bank details).
- Review in a split view: original PDF left, extracted data and actions right.
- Statuses: `processing → needs_review → unpaid → paid`, plus `rejected`.
- Minimal vendor registry (aliases, default terms, trusted bank accounts).
- List with filters, unpaid totals per currency, CSV export.
- Audit trail of every human action.

### Out of scope (v1) — do not build
Notifications/reminders · FX conversion or cross-currency totals · partial payments · ERP/accounting/bank integrations · roles or approval chains · non-PDF attachments (images, xlsx) · field highlighting/bounding boxes on the PDF · multi-tenancy · mobile layout beyond "not broken".

## 2. What the sample invoices taught us

Three real samples live in `fixtures/invoices/` (do not modify them).

| | ASM (Dubai) — fuel at BUD | Petrocas (Tbilisi) — fuel at TBS | AEG Fuels (Ireland/UK) — fuel at OTP |
|---|---|---|---|
| Invoice no. | SI-000218719 | PFSG-CAM-00000000510 | 3110713 |
| Date format | 16-Sep-2026 | 02.10.2026 (DD.MM) | 09/14/2026 (MM/DD) |
| Priced in | USD (AED shown for UAE tax) | USD per metric ton | USD |
| **Payable in** | USD 15,617.79 | **GEL 88,753.98** | USD 6,461.29 |
| Quantity | 2,814.2691 USG | 23,748 L / 18,737 kg | 1,334.590 USG |
| Payment terms | 0 days, 1%/month late interest | none stated | NET7 |
| Dispute window | 14 days from invoice date | none stated | 10 days from receipt |
| Aircraft / flight | 4L-CME / CMS503/4 | — / — | 4LCMX / CMS624 |
| Structure | 1 line | 1 line | 2 lines + 3 fees |

Design consequences:
1. **Amount due ≠ invoice total.** Petrocas prices in USD but must be paid in GEL. We store `total_amount/currency` (as printed) and `amount_due/amount_due_currency` (what we actually remit). Lists and totals use amount due.
2. **Dates are ambiguous across vendors.** The model normalizes to ISO; code cross-checks (due vs terms, service vs invoice date).
3. **Units vary** (USG, L, kg, USD/ton). Line items are generic: quantity, uom, unit price, amount. No unit conversion in v1.
4. **Dispute windows are real deadlines.** Vendors deem invoices accepted after 10–14 days. Review exists to catch errors inside that window, so we derive `dispute_deadline` and sort the review queue by it.
5. **Due dates can be missing** → vendor default terms.
6. **Bank-detail fraud is a known attack** (AEG's invoice warns about it explicitly). A public inbox makes us a target. We keep trusted accounts per vendor and flag mismatches. The beneficiary can differ from the issuer (AEG Fuels Ireland Ltd issues; Associated Energy Group LLC receives).
7. **All three reconcile to the cent** (qty × unit price = amount; items + fees + tax = total; amount × FX = converted amount). Deterministic checks are our confidence signal. We do not ask the model for confidence scores.
8. **Identifiers are inconsistent.** Registrations appear as `4L-CME` and `4LCMX`; airports as ICAO, IATA or names. Normalize registrations (uppercase; `4L` regs → `4L-XXX`); store ICAO and IATA when determinable.

## 3. Architecture

- Monorepo, pnpm workspaces: `apps/api` (NestJS) · `apps/web` (React + Vite) · `packages/shared` (zod schemas + types used by both).
- Postgres 16 + Prisma.
- Background jobs: pg-boss (Postgres-backed, no Redis).
- Files: private S3-compatible bucket (MinIO locally). PDFs are only served through the API behind session auth.
- LLM behind an `InvoiceExtractor` interface; provider and model from env.
- Production: one container (API serves the built SPA and runs the job worker in-process) + Postgres + bucket.
- Business timezone ("today", overdue): `Asia/Tbilisi`.

```
Mailgun ──POST──▶ /api/inbound/mailgun ──┐
Manual upload ──▶ /api/invoices/upload ──┼─▶ store email + PDFs ─▶ invoice rows [processing] ─▶ job
                                                                                                 │
              extract (PDF sent natively to LLM) ◀────────────────────────────────────────────────┘
              → zod-parse → normalize → derive dates → match vendor → compute flags
                                   ▼
                             [needs_review] ──approve──▶ [unpaid] ──mark paid──▶ [paid]
                                   └──reject──▶ [rejected]
```

## 4. Ingestion

### Mailgun
- **Receiving domain.** Mailgun only receives for a domain whose MX points to Mailgun. If `camex.aero` mail is hosted elsewhere (Google/Microsoft), use a subdomain (e.g. `in.camex.aero`) for Mailgun and forward `invoices@camex.aero` → `invoices@in.camex.aero` in the existing mail system. Vendors only ever see `invoices@camex.aero`.
- Route: `match_recipient(...)` → `forward("https://<host>/api/inbound/mailgun")` → `stop()`.
- The endpoint receives `multipart/form-data` (parsed message + attachments as files). Verify field names against current Mailgun docs.
- **Security:** verify `signature == HMAC-SHA256(webhook signing key, timestamp + token)` (hex, constant-time compare); otherwise 401. The endpoint needs no session.
- **Idempotency:** unique on `Message-Id`; a repeated delivery returns 200 and does nothing.
- **Respond fast:** persist email + files, create rows, enqueue jobs, return 200. No LLM calls inside the request.
- Body limit ≥ 30 MB.
- Any webhook limit violation (INBOUND_MAX_REQUEST_MB, file size or count) → 406 so Mailgun doesn't retry; logged at error level.
- Attachments: process `application/pdf` (also `.pdf` extension when MIME is generic). Each PDF → one invoice row. Other attachments: record filename/type/size on the email, don't store content. Emails with zero PDFs are still stored and visible in the Inbox log.
- Exact file duplicates still create a row; validation flags them.

### Manual upload
`POST /api/invoices/upload` (one or more PDFs). Creates an inbound_email with `provider = manual` and `uploaded_by_id`, then follows the same path.

## 5. Data model

Conventions: uuid ids · `timestamptz` timestamps · calendar dates as `date` · money `numeric(18,4)` · unit prices `numeric(18,6)` · quantities `numeric(18,4)` · currency `char(3)` ISO 4217. In JSON, decimals are strings and dates are `YYYY-MM-DD`. Never use JS `number` for money. API JSON uses camelCase; DB columns stay snake_case (Prisma @map).

**users** — id, email (unique, lowercase), name, password_hash, is_active, last_login_at, created_at, created_by_id

**sessions** — id, user_id, token_hash (unique), expires_at, last_seen_at, ip, user_agent, created_at

**inbound_emails** — id, provider (`mailgun|manual`), message_id (unique, null for manual), from_address, sender, recipient, subject, body_text (first 20k chars), headers jsonb, attachments jsonb (`[{filename, content_type, size, processed}]`), received_at, uploaded_by_id, created_at

**vendors** — id, name, aliases text[], email_domains text[], default_payment_terms_days int null, bank_accounts jsonb (`[{id, beneficiary, bank_name, iban, account_number, swift, routing_number, currency, added_at, added_by_id, source_invoice_id, removed_at, removed_by_id}]`), created_at, updated_at
- A bank account entry is added from an invoice (`source_invoice_id`, §9). Removal is soft: `removed_at`/`removed_by_id` are set, matching ignores the entry, and it stays as the audit trail.

**invoices** — one row per PDF
- source: inbound_email_id, file_key, file_name, file_sha256, file_size, page_count
- status: `processing | needs_review | unpaid | paid | rejected`
- extraction: extraction_status (`pending | succeeded | failed`), extraction_error, extraction_raw jsonb, extraction_model, extraction_prompt_version, extracted_at
- document_type: `invoice | credit_note | proforma | statement | other`
- parties: vendor_id (null), vendor_name, vendor_tax_id, bill_to_name
- invoice_number
- dates: invoice_date, service_date, due_date, due_date_source (`printed | terms | vendor_default | manual`, null when there is no due date), dispute_deadline
- terms: payment_terms_text, payment_terms_days, dispute_window_days
- classification: category (`fuel | ground_handling | airport_charges | navigation | catering | maintenance | crew | other`), description (one human-readable line)
- operation: airport_icao, airport_iata, location_text, aircraft_registration, flight_numbers text[]
- amounts: currency, subtotal_amount, tax_amount, total_amount, amount_due, amount_due_currency
- line_items jsonb: `[{kind: item|fee|tax, description, quantity, uom, unit_price, amount}]`
- bank_details jsonb: `{beneficiary, bank_name, iban, account_number, swift, routing_number, currency}`
- notes (anything a payer must know, e.g. late interest)
- flags jsonb: `[{code, severity: error|warning|info, field, message}]` — recomputed on every change
- workflow: approved_at, approved_by_id, paid_at (date), paid_by_id, payment_reference, payment_note, rejected_at, rejected_by_id, rejection_reason (`duplicate | not_invoice | disputed | other`), rejection_note
- created_at, updated_at
- indexes: status, due_date, vendor_id, (vendor_id, invoice_number), file_sha256

**invoice_events** — append-only. id, invoice_id, user_id (null = system), type (`received | extracted | extraction_failed | edited | approved | rejected | paid | payment_undone | reopened | reextracted | vendor_linked | bank_account_trusted`), data jsonb (for `edited`: `{field: {from, to}}`), created_at

## 6. Statuses and transitions

| From | To | Trigger | Rule |
|---|---|---|---|
| processing | needs_review | system | extraction finished (success or failure) |
| needs_review | unpaid | Approve | required: vendor_name, invoice_number, invoice_date, due_date, amount_due, amount_due_currency. Error flags block unless user confirms "approve anyway" (recorded in the event). |
| needs_review | rejected | Reject | reason required |
| needs_review | processing | Re-extract | overwrites extracted fields; confirm first |
| unpaid | paid | Mark paid | paid_at required; reference/note optional |
| unpaid | needs_review | Reopen | to correct data |
| paid | unpaid | Undo payment | |
| rejected | needs_review | Reopen | |

- Fields are editable only in `needs_review`. Each save writes an `edited` event with a diff.
- **Overdue** = `unpaid` and due_date < today (Tbilisi). Not a status. **Due soon** = within 3 days.
- Transitions live in one server-side state machine module, not scattered in controllers. Every transition writes an event.

## 7. Extraction

- Send the PDF natively to a multimodal model. No separate OCR step. Structured output via JSON schema, model default sampling (the current model rejects `temperature`).
- The output schema is defined once in `packages/shared` (zod) and converted to JSON Schema for the provider.
- The model extracts **what is printed**. Code derives the rest:
  - `due_date`: printed → else invoice_date + payment_terms_days → else invoice_date + vendor default terms → else null. `due_date_source` records which (`printed`, `terms`, `vendor_default`); a `printed` or `manual` date is never re-derived. The extraction write stores the printed date with source `printed`, or neither.
  - `dispute_deadline`: invoice_date + dispute_window_days (conservative when the clause says "from receipt").
- The prompt is a versioned constant (`extract-v1`, …) and must state:
  - We are the customer: Camex Airlines LLC, Tbilisi, Georgia (ID 405487487). The vendor is the other party.
  - `amount_due/amount_due_currency` = what the payer must remit per the payment instructions; can differ from the pricing currency.
  - Dates as ISO. Resolve ambiguous formats using other evidence on the document (terms, other dates, vendor country).
  - Null when absent. Never invent values.
  - All line items, fees and taxes, with `kind`.
  - `category` from the fixed list; `description` one short line (e.g. "Jet A-1 uplift, BUD, CMS503/4").
  - `document_type` classified honestly (T&Cs, delivery tickets and statements are not invoices).
- Pipeline: call → zod-parse (one re-ask on invalid output) → store raw → map → normalize → derive dates → vendor match → flags → `needs_review`.
- Failures (API error, timeout, invalid output after re-ask): job retries transient errors (3 attempts, backoff); then `extraction_status = failed`, error stored, status `needs_review` so a human can enter data manually.
- The extractor has no tools; its output is data only. A malicious PDF can at most produce wrong data, which review and flags exist to catch.
- Provider: Anthropic (`EXTRACTOR_PROVIDER=anthropic`), `EXTRACTION_MODEL` defaulting to `claude-sonnet-5-5`.
- Wire format: every field is required, an absent value is `""` (strings) or `[]` (arrays), and there are no unions (no nullable types, no `anyOf`). Anthropic structured outputs allow at most 16 union-typed and 24 optional properties per request ("Schema is too complex for compilation" beyond that), and the schema has about 27 nullable fields. Normalization in code turns `""` into null.
- Non-retryable (failed immediately, no further attempts): a refusal, output cut off at `max_tokens`, and output still invalid after the re-ask.
- The recovery sweep re-enqueues invoices stuck in `processing` for 10–60 minutes; past 60 minutes it gives up (`extraction_failed`, "Extraction did not finish within 60 minutes", `needs_review`).
- Flight-number shorthand (`CMS503/4` → `CMS503`, `CMS504`) and registration normalization (`4LCMX` → `4L-CMX`) happen in code, not in the prompt.
- **Eval:** `pnpm eval:extraction` runs every fixture and diffs against `fixtures/invoices/expected/*.json`, per field. Run on every prompt or model change. Golden files are provided by the CTO in T03.
- Thinking and effort stay at the model defaults. A change to the model, effort or prompt requires an eval run.

## 8. Validation flags (code, not LLM)

Recomputed after extraction (success or final failure), after every edit, after every vendor change (for that vendor's `needs_review` and `unpaid` invoices; a new vendor or a changed name, alias or domain also re-matches unlinked `needs_review` invoices), and daily at 00:05 Asia/Tbilisi for every `needs_review` and `unpaid` invoice (DISPUTE_SOON and FUTURE_DATE depend on the date). No flags while `processing`. Money tolerance: |diff| ≤ max(0.05, 0.01% of expected), decimal arithmetic only.

Each flag is `{code, severity, field, message}`. `field` is the camelCase path of the field it is about, for the review UI to focus (`dueDate`, `totalAmount`, `lineItems.1.amount`, `bankDetails.iban`), or null. Flags are ordered errors, then warnings, then info (table order within a severity). Messages are plain English and never contain bank account numbers.

| Code | Severity | Rule |
|---|---|---|
| EXTRACTION_FAILED | error | extraction failed |
| MISSING_REQUIRED | error | a field required for approval is empty (one flag per field) |
| TOTAL_MATH | error | neither sum(line amounts) nor sum(line amounts) + tax_amount equals total_amount; skipped without line items or total |
| LINE_MATH | warning | quantity × unit_price ≠ amount on a line (lines with all three only) |
| DUE_BEFORE_INVOICE | error | due_date < invoice_date |
| TERMS_MISMATCH | warning | printed due_date ≠ invoice_date + payment_terms_days (source `printed` and terms set) |
| DUE_DATE_DERIVED | info | due_date was computed, not printed (source `terms` or `vendor_default`) |
| FUTURE_DATE | warning | invoice_date > today |
| SERVICE_AFTER_INVOICE | warning | service_date > invoice_date |
| PAY_IN_OTHER_CURRENCY | info | amount_due_currency ≠ currency |
| NOT_BILLED_TO_CAMEX | warning | bill_to_name doesn't contain "camex" (case-insensitive), or is empty |
| NOT_AN_INVOICE | warning | document_type ∉ {invoice, credit_note} |
| DUPLICATE_FILE | error | same sha256 on another non-rejected invoice, in any status (including paid) |
| DUPLICATE_NUMBER | error | same invoice number (uppercase, spaces removed) and same vendor on another non-rejected invoice, in any status: same vendor_id, or the same normalized vendor_name when either is unlinked |
| NEW_VENDOR | info | no vendor matched |
| BANK_FIRST_SEEN | warning | vendor linked, invoice has an IBAN/account number, vendor has no active trusted accounts yet |
| BANK_UNKNOWN | error | vendor has active trusted accounts; extracted account matches none |
| DISPUTE_SOON | warning | needs_review and dispute_deadline within 3 days, including deadlines already passed ("Dispute window ended …") |

Bank matching compares normalized IBAN / account number (spaces removed, uppercase): the IBAN when there is one, else the account number.

Duplicates converge even when two arrive at once: after each commit the invoice is re-evaluated, then every other invoice sharing its sha256 or invoice number, so whichever commits last re-flags the other. On approve with `BANK_FIRST_SEEN`, the dialog shows the bank details and offers "trust these details for <vendor>" (writes `bank_account_trusted`). `BANK_UNKNOWN` requires "approve anyway" and shows: "Bank details differ from the ones on file. Verify by phone with the vendor before paying."

## 9. Vendors

- Matching runs for unlinked invoices in `needs_review` (after extraction and on the re-evaluations of §8). Order: the normalized vendor_name against each vendor's name and aliases; then the sender's email domain (the From address) against email_domains, only for emails received through Mailgun (never manual uploads) and never for a domain in `OWN_EMAIL_DOMAINS` (config, comma-separated, default `camex.aero`; subdomains included). A name match beats a domain match. A match writes `vendor_linked` (`{vendorId, method: name | alias | email_domain}`, system). No match → vendor_id null + `NEW_VENDOR`.
- Normalized name ("vendor key"): lowercase, punctuation removed, whitespace collapsed, a leading "შპს" or "ооо" removed, trailing legal forms removed repeatedly (llc, ltd, limited, fze, fzco, fzllc, gmbh, inc, incorporated, corp, corporation, co, company, plc, llp, sa, srl, sarl, bv, ag, jsc, ojsc, cjsc, ooo, na).
- Uniqueness: name and alias keys are unique across all vendors' names and aliases, and email domains across vendors (409 naming the other vendor). Domains are lowercase hostnames; `OWN_EMAIL_DOMAINS` and public mailbox domains (gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, mail.ru, yandex.ru, proton.me) are refused. Default terms: 0–365 days or none.
- On approve without a vendor: "Create vendor" or "Link to existing" (searchable). A manual link (`vendor_linked`, `method: manual`) adds the extracted vendor_name to the vendor's aliases when neither its name nor an alias matches it (subject to the uniqueness rule).
- Trusted bank accounts are added only from an invoice ("trust these details", in `needs_review` or `unpaid`, writes `bank_account_trusted` with ids only); there is no manual entry in v1. Removal is soft (§5).
- Vendors page: list; edit name, aliases, domains, default terms; view/remove trusted bank accounts.

## 10. UI

**Invoices list `/invoices`**
- Status tabs with counts: Needs review · Unpaid · Paid · Rejected · All. Rows still `processing` appear in Needs review with a "Processing…" badge.
- Summary strip: unpaid totals grouped by currency (never converted) · overdue count · due in next 7 days.
- Columns: received, vendor, invoice #, invoice date, due date (red overdue, amber due soon), amount due + currency, category, location, flags (counts by severity).
- Default sort: Needs review → dispute_deadline asc, then received asc · Unpaid → due_date asc · Paid → paid_at desc.
- Filters: search (vendor, invoice #, flight, registration), vendor, category, currency, invoice date range. CSV export of the current filter. Upload button (drag & drop).

**Invoice detail `/invoices/:id` — split view**
- Left (~55%, resizable): PDF via pdf.js/react-pdf; page nav, zoom, fit width, download, open in new tab.
- Right: header (vendor, invoice #, status badge, amount due prominent) · flags panel (errors first; field-linked flags focus that field on click) · form sections: Document · Dates & terms · Amounts · Operation · Line items (editable table) · Bank details · Notes. Read-only outside `needs_review`. Fields that differ from the extraction show an "edited" marker.
- Sticky action bar by status: needs_review → Save, Approve, Approve & next, Reject, Re-extract · unpaid → Mark paid, Reopen · paid → Undo payment · rejected → Reopen.
- Below: Source email (from, subject, received, body, ignored attachments) and Activity timeline.

**Inbox `/inbox`** — log of inbound emails: received, from, subject, PDF count, links to resulting invoices, ignored attachments.

**Vendors `/vendors`**, **Users `/users`**.

## 11. Auth and users

- Email + password (argon2id). No signup endpoint. The first admin is created from BOOTSTRAP_ADMIN_* env vars on boot, only when no users exist (CLI kept for local dev). A password set by someone else must be changed on first login. Admins can reset another user's password to a temporary one. Admins create other admins with an initial password shared out-of-band; users can change their password.
- DB-backed sessions: opaque 32-byte random token in an httpOnly cookie (Secure in prod, SameSite=Lax); only its SHA-256 is stored. 14-day expiry, extended on use.
- Login rate-limited per IP and per email; generic error messages.
- Users are deactivated, never deleted. Deactivation revokes sessions. You can't deactivate yourself.
- All authenticated users have full permissions.

## 12. Non-functional

- Config validated with zod at boot; fail fast on missing env.
- Structured logs (pino). Log inbound and extraction outcomes. Never log bank details or file contents.
- Server-side input validation with zod from `packages/shared`.
- Daily Postgres backups and bucket versioning in production (T07).

## 13. Task roadmap

| # | Task | Done when |
|---|---|---|
| T01 | Foundation: monorepo, docker-compose, full schema, auth, users, web shell | can log in and manage admins |
| T02 | Ingestion: Mailgun webhook, storage, manual upload, job queue with stub extractor, Inbox page, webhook simulator | fixture PDFs arrive via simulated webhook and reach needs_review |
| T03 | Extraction: extractor interface + provider, prompt v1, mapping/normalization, eval + golden files | all fixtures pass eval |
| T04 | Validation + vendors: flag engine, derived dates, dedupe, vendor matching, bank checks, Vendors page | flags correct on fixtures and crafted cases |
| T05 | Invoices list: tabs, filters, totals, CSV, upload | |
| T06 | Detail split view + state machine + actions + audit trail | full review → paid loop works |
| T07 | Deploy: Dockerfile, env, Mailgun/DNS runbook, backups, prod checklist | live, real email processed |

## 14. Working agreement

- Each task is a prompt from the CTO. Claude Code reads this spec and `CLAUDE.md`, implements only that task, and writes `docs/reports/Txx-<slug>.md`.
- If implementation exposes a spec problem, record it under "Questions for the CTO". Don't silently redesign.
- Each task runs on branch tNN-<slug> and ends with one commit; the CTO reviews before merge. Reports include `git diff --stat main...HEAD`.
- Report sections: Summary · What was built · Deviations (with reasons) · Unspecified decisions made · How to verify (exact commands from a clean clone, expected result) · Test results (command + output summary) · Known issues / shortcuts · Questions for the CTO.
