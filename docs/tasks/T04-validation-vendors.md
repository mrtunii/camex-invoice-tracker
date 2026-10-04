# T04 — Validation flags, derived dates, vendors

You are implementing task T04 of the Camex Invoice Tracker. Read CLAUDE.md, docs/SPEC.md (§5–§9), docs/reports/T03-extraction.md and this file before writing code.

## 0. Git

- Precondition: `main` contains T03. `git status` on main shows only the untracked `docs/tasks/T04-validation-vendors.md` (CTO-provided). Anything else → stop and ask.
- Create branch `t04-validation-vendors`. Commit this file as part of T04. One commit "T04: validation + vendors". Do not merge or push.

## 1. CTO decisions on the T03 questions

1. **SPEC §7:** replace "temperature 0" with "model default sampling (the current model rejects `temperature`)".
2. **Refusal fallback:** no. Refusals stay non-retryable.
3. **Thinking/effort:** leave the model defaults. A change to the model, effort or prompt requires an eval run (add this sentence to SPEC §7).
4. **More golden files:** yes, but from real documents. Otto is collecting them; that becomes a separate eval task. Not in T04.
5. **Numeric overflow:** `decimal()` in normalization returns null when the value has more than 14 integer digits (it wouldn't fit `numeric(18,4)`). Unit-test it, then run `pnpm eval:extraction` once to confirm 3/3 still pass, and paste the summary line.

## 2. Schema changes (one migration)

- `invoices.due_date_source`: enum `printed | terms | vendor_default | manual`, nullable.
- Each `vendors.bank_accounts` entry gains `id` (uuid), `source_invoice_id`, `removed_at`, `removed_by_id`. Removal is soft: matching ignores removed entries, and they stay as the audit trail.
- SPEC §5: document both.

## 3. Shared helpers (packages/shared, pure, unit-tested)

**`vendorKey(name)`**
- lowercase, punctuation removed, whitespace collapsed;
- trailing legal-form tokens removed repeatedly: llc, ltd, limited, fze, fzco, fzllc, gmbh, inc, incorporated, corp, corporation, co, company, plc, llp, sa, srl, sarl, bv, ag, jsc, ojsc, cjsc, ooo, na;
- a leading "შპს" or "ооо" removed.

Examples:

| Input | Key |
|---|---|
| Petrocas Fuel Services Georgia LLC | petrocas fuel services georgia |
| Wells Fargo Bank, N.A. | wells fargo bank |
| შპს კამექს ეარლაინს | კამექს ეარლაინს |

The eval scorer's name rule should reuse it if that doesn't change any T03 result.

**Other keys**
- `invoiceNumberKey(n)`: uppercase, spaces removed.
- `bankAccountKey(details)`: the normalized IBAN, else the account number with spaces removed and uppercased, else null.

**`businessToday(clock)`**: today in Asia/Tbilisi as `YYYY-MM-DD`. Use the existing helper if there is one. The clock is injectable for tests.

## 4. Derived dates (SPEC §7)

`deriveDates(invoice, vendor)`:

- **Due date**
  - `due_date_source` is `printed` or `manual` → keep `due_date`.
  - Otherwise: `invoice_date + payment_terms_days` (source `terms`); else `invoice_date + vendor.default_payment_terms_days` (source `vendor_default`); else `due_date` and source both null.
- **`dispute_deadline`** = `invoice_date + dispute_window_days`, else null. Always derived.
- **The extraction write** sets `due_date` = the printed value and `due_date_source = printed` when one was printed; otherwise both null, and derivation fills them.

## 5. Flags (SPEC §8)

**Pure function `computeFlags(input, today) → Flag[]`.**
- `input` = the invoice fields, its vendor (with active trusted accounts) or null, and the duplicate candidates.
- `Flag = { code, severity, field, message }`. `field` is a camelCase path the T06 UI can focus: `dueDate`, `totalAmount`, `lineItems.1.amount`, `bankDetails.iban`, or null.
- Order: errors, then warnings, then info.
- No flags for invoices in `processing`.
- Messages are plain English and never contain bank numbers.

Rules as in SPEC §8, with these clarifications:

| Code | Clarification |
|---|---|
| EXTRACTION_FAILED | `extraction_status = failed` |
| MISSING_REQUIRED | one flag per empty field: vendorName, invoiceNumber, invoiceDate, dueDate, amountDue, amountDueCurrency |
| TOTAL_MATH | skip if there are no line items or no total. Tolerance: \|diff\| ≤ max(0.05, 0.01% of the total). Decimal arithmetic only, never floats. |
| LINE_MATH | only lines with quantity, unitPrice and amount; same tolerance against the line amount |
| TERMS_MISMATCH | only when `due_date_source = printed` and payment_terms_days is set |
| DUE_DATE_DERIVED | source `terms` or `vendor_default` |
| NOT_BILLED_TO_CAMEX | also when bill_to_name is null ("No bill-to name found") |
| DUPLICATE_FILE | same sha256 on another non-rejected invoice (any status, including paid) |
| DUPLICATE_NUMBER | another non-rejected invoice with the same `invoiceNumberKey` and the same vendor: same vendor_id, or equal `vendorKey(vendor_name)` when either side is unlinked |
| NEW_VENDOR | vendor_id null |
| BANK_FIRST_SEEN | vendor linked, `bankAccountKey` not null, vendor has no active trusted accounts |
| BANK_UNKNOWN | vendor linked, `bankAccountKey` not null, vendor has active trusted accounts and none has the same key |
| DISPUTE_SOON | `needs_review` and `dispute_deadline − today ≤ 3 days`, including deadlines already passed. The message says "Dispute window ends 2026-09-30" or "Dispute window ended 2026-09-30". |

## 6. Evaluator (one service, reused by T06)

**`InvoiceEvaluator.evaluate(tx, invoiceId, today)`** does four steps:
1. **Vendor match**, only if `vendor_id` is null and status is `needs_review`:
   - `vendorKey(vendor_name)` against each vendor's name and aliases;
   - else the sender's email domain against `email_domains`. Only for `provider = mailgun`; never a domain in `OWN_EMAIL_DOMAINS`.
   - A match sets `vendor_id` and writes a `vendor_linked` event `{ vendorId, method: name | alias | email_domain }` with user null.
2. Derive dates (§4).
3. Compute flags.
4. Write `vendor_id`, `due_date`, `due_date_source`, `dispute_deadline` and `flags`.

**`evaluateWithRelated(invoiceId)`** runs after commit:
- evaluate the invoice;
- then evaluate every other invoice sharing its sha256 or its duplicate-number key, each in its own transaction.

Duplicates converge this way even when two arrive at the same time: whichever commits last re-flags the other. Write a test for both orders.

**Triggers**
- after extraction success and after the final-failure path (handler and sweep);
- after any vendor change (§7): re-evaluate that vendor's `needs_review` and `unpaid` invoices; after create, or after a change to name, aliases or domains, also re-match unlinked `needs_review` invoices;
- a **daily pg-boss schedule at 00:05 Asia/Tbilisi** that re-evaluates every `needs_review` and `unpaid` invoice. DISPUTE_SOON and FUTURE_DATE depend on the date. Verify pg-boss's timezone option for `schedule`.

**Config:** `OWN_EMAIL_DOMAINS` (comma-separated, default `camex.aero`).

## 7. Vendors API (session required)

**`GET /api/vendors?search=`**
- Returns: id, name, aliases, emailDomains, defaultPaymentTermsDays, activeBankAccountCount, openInvoiceCount (`needs_review` + `unpaid`).
- Sorted by name.

**`POST /api/vendors`** `{ name, aliases?, emailDomains?, defaultPaymentTermsDays? }`, and **`PATCH /api/vendors/:id`** with the same fields.
- Name and alias keys must be unique across all vendors' names and aliases → 409 naming the other vendor.
- Domains: lowercase, valid hostname, unique across vendors (409).
- Rejected domains: `OWN_EMAIL_DOMAINS` and public mailbox domains (gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, mail.ru, yandex.ru, proton.me).
- `defaultPaymentTermsDays`: 0–365 or null.

**`GET /api/vendors/:id`**: the list fields plus `bankAccounts`, active and removed, each with the added/removed user's name, the dates and `sourceInvoiceId`.

**`DELETE /api/vendors/:id/bank-accounts/:accountId`**
- Soft remove: sets `removed_at`/`removed_by_id`.
- Idempotent. Re-evaluates the vendor's open invoices.

**`POST /api/invoices/:id/vendor`** `{ vendorId } | { create: { name, defaultPaymentTermsDays? } }`
- Only in `needs_review`, otherwise 409.
- Links the vendor. If `vendorKey(invoice.vendor_name)` matches neither the vendor's name nor its aliases, the extracted vendor_name is added as an alias (subject to the uniqueness rule).
- Writes `vendor_linked` `{ vendorId, method: manual }` with the user.
- Then `evaluateWithRelated`.

**`POST /api/invoices/:id/trust-bank-details`**
- Allowed in `needs_review` and `unpaid`. Requires a linked vendor and a non-null `bankAccountKey`, otherwise 409.
- Adds the invoice's bank details to the vendor's trusted accounts, with `added_by_id`, `added_at` and `source_invoice_id`. If an active account already has the same key, nothing changes and the response is 200.
- Writes a `bank_account_trusted` event `{ vendorId, accountId }`; no account numbers in event data.
- Re-evaluates the vendor's open invoices.

**DTO:** `GET /api/invoices/:id` adds `vendor` (`{ id, name }` or null), `dueDateSource` and `disputeDeadline`. `flags` is now real.

**Logs:** vendor and trust actions log userId, vendorId and the action only. Never bank details.

## 8. Web

**`/vendors`**
- Table: name, aliases, domains, default terms, trusted accounts, open invoices. Search box. "Add vendor" dialog.
- Clicking a row opens a sheet with:
  - an edit form (name, aliases and domains as tag inputs, default terms);
  - active trusted accounts: beneficiary, bank, IBAN or account number in full, SWIFT, currency, added by and when, "from invoice" link to `/invoices/:id` (that page comes in T06, so the link may 404 until then), and a Remove button behind a confirm dialog;
  - a collapsed "Removed accounts" list.
- 409 messages are shown inline on the field.

**`/inbox`:** each invoice chip also shows flag counts by severity (e.g. a red "2" and an amber "1"), with a tooltip listing the codes.

## 9. SPEC edits

- §5: `due_date_source`; the bank account entry fields; soft removal.
- §7: the temperature wording and the eval rule from §1.
- §8: the clarifications in §5 (field paths, DISPUTE_SOON includes passed deadlines, duplicates span all non-rejected statuses); flags are recomputed after changes and daily at 00:05 Asia/Tbilisi.
- §9: matching order and the domain rules, name/alias/domain uniqueness, `OWN_EMAIL_DOMAINS`, aliases added on manual link, trusted accounts only via an invoice (no manual entry in v1), soft removal.

## Tests

**Pure functions**
- `vendorKey` (the examples above plus trailing-only removal); `invoiceNumberKey`; `bankAccountKey`; `decimal()` overflow.
- `deriveDates`: every branch, including `manual` and `printed` kept, and vendor default terms used only without printed terms.
- `computeFlags`: every code triggering and not triggering, tolerance boundaries (0.05 and 0.01%), DISPUTE_SOON (in 3 days, passed, not `needs_review`), and severity order.

**Fixtures, with `today = 2026-10-02`, normalized golden files as input:**

| Fixture | No vendors exist | Vendor exists (by name), no trusted accounts |
|---|---|---|
| asm | DISPUTE_SOON (warning, ended 2026-09-30) · NEW_VENDOR (info) | DISPUTE_SOON · BANK_FIRST_SEEN |
| petrocas | MISSING_REQUIRED dueDate (error) · PAY_IN_OTHER_CURRENCY (info) · NEW_VENDOR (info) | with default terms 10: dueDate 2026-10-12, source `vendor_default`; BANK_FIRST_SEEN · DUE_DATE_DERIVED · PAY_IN_OTHER_CURRENCY |
| aeg | DISPUTE_SOON (warning, ended 2026-09-24) · NEW_VENDOR (info) | DISPUTE_SOON · BANK_FIRST_SEEN |

And: after trusting AEG's account, a second AEG invoice with a different account number gets BANK_UNKNOWN (error) and the first has no bank flag.

**Integration (API, DB)**
- matching by name, alias and domain; manual uploads never match by domain; own domains never match; a name match beats a domain match;
- duplicates:
  - the same PDF twice → both DUPLICATE_FILE; set one to `rejected` and re-evaluate → the other clears;
  - same vendor + number → both DUPLICATE_NUMBER; a different vendor with the same number → none;
  - convergence in both commit orders;
- vendor API: create, update, search, every 409, domain validation, soft remove; creating a vendor links pending invoices and updates their flags;
- link API: alias added; 409 outside `needs_review`;
- trust API: account added, dedupe, flags updated on the vendor's open invoices; 409 without a vendor or bank details;
- daily job: registered with the timezone; moving the injected clock flips DISPUTE_SOON;
- extraction handler: flags, derived dates and vendor are set after success; EXTRACTION_FAILED and MISSING_REQUIRED after the final failure.

## Out of scope

Approve, reject, pay and edit actions, the invoice list and detail UI (T05/T06), manual entry of bank accounts, vendor deletion, vendor merge.

## Done when

- The fixture table above passes as tests.
- With `EXTRACTOR_PROVIDER=anthropic`:
  1. `pnpm simulate:mailgun` → `GET /api/invoices/:id` shows the "no vendors" flags (dates relative to the real today).
  2. Create the three vendors on `/vendors` → the invoices link by name, and their flags switch to BANK_FIRST_SEEN.
  3. Trust one invoice's bank details through the API → that flag clears.
  4. Remove the account on `/vendors` → it comes back.

## Report

`docs/reports/T04-validation-vendors.md` with the sections from CLAUDE.md plus `git diff --stat main...HEAD`. Don't claim anything works unless you ran it.
