# T04 — Validation flags, derived dates, vendors

Branch `t04-validation-vendors`, one commit "T04: validation + vendors" on top of `main` (T03, `1e9d3b0`). Not merged, not pushed. The commit includes the CTO-provided `docs/tasks/T04-validation-vendors.md`. `docs/tasks/T07-deploy.md` appeared untracked in the working tree during this task; I didn't create it and left it out of the commit.

## 1. Summary

Every extracted invoice is now evaluated. It is matched to a vendor (name or alias, else the sender's domain), its due date and dispute deadline are derived, and the SPEC §8 flags are computed and stored. The evaluation re-runs after extraction (success and final failure), after every vendor change and daily at 00:05 Asia/Tbilisi. Vendors have an API and a `/vendors` page. Bank accounts are trusted from an invoice and soft-removed. The Inbox shows flag counts per invoice.

What was run (details in §5–§6):

- **"Done when", with `EXTRACTOR_PROVIDER=anthropic`, in a clean clone (production build, empty database):**
  1. `pnpm simulate:mailgun` → `GET /api/invoices/:id` showed exactly the "no vendors" flags.
  2. Creating the three vendors on `/vendors` (headless Chromium) linked all three invoices by name, and BANK_FIRST_SEEN replaced NEW_VENDOR.
  3. Trusting AEG's bank details through the API cleared its flag.
  4. Removing the account on `/vendors` brought it back.
- **Fixture table:** passes as unit tests (`test/flags.test.ts`) and as an end-to-end test through the extraction handler and the API (`test/evaluation.e2e.test.ts`), both with today = 2026-10-02.
- **Tests:** `pnpm test` gives 256/256 (23 files), here and in the clean clone. Lint, typecheck and build are clean.
- **CTO decision 5:** `pnpm eval:extraction` (one run) printed `passed: 3/3 · aeg 1/1, asm 1/1, petrocas 1/1`. That run covers both the `decimal()` overflow rule and the eval scorer now using `vendorKey`.
- **Bugs found and fixed:**
  - A bug in the vendor edit form, found during the UI walkthrough (§7).
  - Four findings from an independent review pass of the diff (§3, §4).

## 2. What was built

**CTO decisions on the T03 questions (task §1)**

- SPEC §7 now says "model default sampling (the current model rejects `temperature`)". It also says thinking and effort stay at the model defaults, and that a model, effort or prompt change requires an eval run.
- `decimal()` (`apps/api/src/extraction/normalize.ts`) returns null for more than 14 integer digits, leading zeros aside, so the value can't fail the `numeric(18,4)` write. Unit-tested; eval run in §6.
- Refusals stay non-retryable; nothing changed.
- No new golden files (separate task).

**Schema (one migration, `20261004124608_validation_vendors`)**

- New enum `due_date_source` (`printed | terms | vendor_default | manual`) and a nullable column `invoices.due_date_source`.
- Backfill: `due_date_source = 'printed'` where `due_date` is set. Before T04 every stored due date came from the extraction.
- `vendors.bank_accounts` entries gain `id`, `source_invoice_id`, `removed_at` and `removed_by_id`. This is jsonb, so there is no DDL. The shape is documented in `schema.prisma` and SPEC §5, and validated with zod in `apps/api/src/vendors/bank-accounts.ts`. No entries existed before T04.

**Shared helpers (`packages/shared`, pure)**

- `keys.ts`: `vendorKey`, `invoiceNumberKey`, `bankAccountKey`, as in task §3.
- `dates.ts`:
  - `businessToday(clock)` (Asia/Tbilisi via `Intl`, no helper existed before);
  - `addDays`, `daysBetween`, `Clock`, `BUSINESS_TIME_ZONE`.
- `vendors.ts`: the vendor API schemas, plus `vendorNameSchema`, `hostnameSchema`, `emailDomainSchema` and `PUBLIC_MAILBOX_DOMAINS`. The UI validates with the same rules.
- `invoices.ts`: `dueDateSourceSchema`, `flagCodeSchema` (the 18 codes in SPEC order), `flagSeveritySchema`, and `vendor`/`dueDateSource` on `invoiceDetailSchema`.
- The eval scorer's name rule (`namesMatch`) now uses `vendorKey`. It gives identical results on the T03 outputs (§6).

**Derived dates (`apps/api/src/evaluation/derive-dates.ts`)**

- `deriveDates(invoice, vendor)` as in task §4.
- The extraction write (`extractedInvoiceColumns`) stores the printed due date with source `printed`, or neither.

**Flags (`apps/api/src/evaluation/flags.ts`)**

- Pure `computeFlags({ invoice, vendor, candidates }, today)` returns `{code, severity, field, message}[]`. Order: errors, warnings, info, and within a severity the SPEC §8 table order.
- Every rule from SPEC §8 is implemented, with the clarifications in task §5.
- All money arithmetic uses `Prisma.Decimal` (decimal.js, already a Prisma dependency). Tolerance is |diff| ≤ max(0.05, 0.01 % × |expected|).
- No flags while `processing`. Messages never contain bank numbers (tested).

**Evaluator (`apps/api/src/evaluation/invoice-evaluator.ts`)**

- **`evaluate(tx, invoiceId, today)`.** It locks the invoice row (`SELECT … FOR UPDATE`), then:
  1. matches a vendor if the invoice is unlinked and `needs_review`, writing a system `vendor_linked` event;
  2. derives dates;
  3. computes flags against the vendor's active trusted accounts and the duplicate candidates;
  4. writes `vendor_id`, `due_date`, `due_date_source`, `dispute_deadline` and `flags`, but only if something changed.
- **`evaluateWithRelated(invoiceId)`.** Evaluates the invoice, then every other invoice with the same `file_sha256` or invoice number key, each in its own transaction.
- **`reevaluateVendor(vendorId, { rematch })`.** Re-evaluates the vendor's `needs_review` and `unpaid` invoices; with `rematch`, also every unlinked `needs_review` invoice.
- **`reevaluateOpen()`.** The daily run.
- **Triggers:**
  - the extraction handler, after success and after both final-failure paths;
  - the recovery sweep's give-up path;
  - every vendor write, link and trust.
- **Daily schedule (`evaluation.workers.ts`):**
  - queue `invoice.reevaluate`;
  - `boss.schedule('invoice.reevaluate', '5 0 * * *', null, { tz: 'Asia/Tbilisi', missed: 'once' })`;
  - registered unless `WORKERS_ENABLED=false`.
  - pg-boss 12.36's `ScheduleOptions` has `tz` (default UTC) and `missed` (default `skip`). The stored schedule has `timezone: 'Asia/Tbilisi'` (tested).
- **Clock:** a `CLOCK` provider (`apps/api/src/clock/`), one object per app, so tests can move "today".
- **Config:** `OWN_EMAIL_DOMAINS` (comma-separated, default `camex.aero`, validated as hostnames).

**Vendors API (`apps/api/src/vendors/`, session required)**

- `GET /api/vendors?search=`:
  - returns `{ vendors: [...] }` with the list fields from task §7;
  - sorted by name, case-insensitively;
  - search matches the name, an alias or a domain.
- `GET /api/vendors/:id`: the list fields plus `bankAccounts`, active and removed, each with `addedBy`/`removedBy` (`{id, name}`), the dates and `sourceInvoiceId`.
- `POST /api/vendors` (201) and `PATCH /api/vendors/:id` (200) return the vendor detail.
  - **409** when a name or alias key, or a domain, is taken. The body is `{statusCode, message, field, vendor: {id, name}}`, where `field` is the request path (`name`, `aliases.2`, `emailDomains.0`).
  - **400** for public mailbox domains (shared zod schema) and for `OWN_EMAIL_DOMAINS`, including subdomains. Same issues format as every other validation error.
- `DELETE /api/vendors/:id/bank-accounts/:accountId` (200, vendor detail): soft remove, idempotent, then re-evaluation.
- `POST /api/invoices/:id/vendor` and `POST /api/invoices/:id/trust-bank-details` (200, invoice detail): as in task §7. The alias rule is in §4.
- **Writes:**
  - Every vendor write takes one transaction-scoped advisory lock, since uniqueness spans vendors and bank accounts are read-modify-write jsonb.
  - Link and trust also lock the invoice row.
  - Re-evaluation runs after commit.
- **Logs:** vendor and trust actions log `{userId, vendorId, action}` (`vendor_created`, `vendor_updated`, `invoice_vendor_linked`, `bank_account_trusted`, `bank_account_removed`). The `bank_account_trusted` event carries `{vendorId, accountId}` only.

**DTOs**

- `GET /api/invoices/:id` adds `vendor` (`{id, name}` or null) and `dueDateSource`; `flags` are real.
- `GET /api/inbox` adds `flags` (code and severity) to each invoice.

**Web**

- **`/vendors`:**
  - table (name, aliases, domains, default terms, trusted accounts, open invoices);
  - debounced search;
  - "Add vendor" dialog.
- **Vendor sheet (opened by a row):**
  - Edit form: name, aliases and domains as tag inputs, default terms. 409 and 400 errors show inline on their field.
  - Active trusted accounts, numbers in full, with who added them, when, and a "From invoice" link. A Remove button sits behind a confirm dialog.
  - A collapsed "Removed accounts" list.
- **`/inbox`:** each invoice chip shows counts by severity (red errors, amber warnings, grey info) with a tooltip listing the codes.
- **New components:**
  - `components/tag-input.tsx`;
  - `components/flag-counts.tsx`;
  - `components/ui/tooltip.tsx`, the shadcn tooltip over `radix-ui`, which is already a dependency.
- No new dependencies anywhere in T04.

**Docs:** SPEC §5, §7, §8 and §9 as in task §9. `.env.example` has `OWN_EMAIL_DOMAINS`. README has a "Flags and vendors" section.

## 3. Deviations (with reasons)

1. **Within a severity, flags follow the SPEC §8 table order.** So for ASM and AEG with a vendor, the result is `BANK_FIRST_SEEN, DISPUTE_SOON`. The task's fixture table lists "DISPUTE_SOON · BANK_FIRST_SEEN". The task fixes only errors → warnings → info, and table order is the one stable rule that covers every code (question 3).
2. **Log lines carry more than `userId, vendorId, action`.** Vendor action lines are written inside a request, so pino-http adds its request context: request id, method, URL and remote address. The URL can contain the vendor and account ids. No names or bank details are logged (scanned, §6).

## 4. Decisions not in the spec

**Keys and validation**

- **`vendorKey`:**
  - "Punctuation removed" means every Unicode punctuation or symbol character is deleted, not replaced by a space. `N.A.` becomes `na` and `FZ-LLC` becomes `fzllc`, both then removed as legal forms. `Petro-Cas` becomes `petrocas`.
  - The leading `ооо` is Cyrillic, as in the task text. A Latin `OOO` is removed only as a trailing token.
- **Names and aliases that are only a legal form** ("LLC") have an empty key and are refused with 400. They could never match anything.
- **Repeats within one vendor are dropped silently on save:** an alias whose key equals the name's or an earlier alias's, and repeated domains.
- **`OWN_EMAIL_DOMAINS` includes subdomains** (`in.camex.aero`), both for matching and for refusing vendor domains. Vendor domains themselves match exactly, with no subdomains (question 4).

**Matching**

- **The sender's domain** comes from the stored `from_address`. That is the parsed From header, which already falls back to the envelope sender (T02).
- **A failed extraction can still match by domain.**

**Flag details**

- **Field paths:**

  | Flag                              | `field`                                                                              |
  | --------------------------------- | ------------------------------------------------------------------------------------ |
  | NEW_VENDOR                        | `vendorName`                                                                         |
  | DISPUTE_SOON                      | `disputeDeadline`                                                                    |
  | DUPLICATE_NUMBER                  | `invoiceNumber`                                                                      |
  | PAY_IN_OTHER_CURRENCY             | `amountDueCurrency`                                                                  |
  | NOT_BILLED_TO_CAMEX               | `billToName`                                                                         |
  | NOT_AN_INVOICE                    | `documentType`                                                                       |
  | bank flags                        | `bankDetails.iban` when the key came from the IBAN, else `bankDetails.accountNumber` |
  | EXTRACTION_FAILED, DUPLICATE_FILE | null                                                                                 |

  Line paths are 0-based (`lineItems.1.amount`); messages say "Line 2".

- **Messages:**
  - single sentences without a final period, matching the task's "Dispute window ended 2026-09-30";
  - amounts with at least 2 decimals;
  - the DUE_DATE_DERIVED day count is computed from the two dates.
- **TOTAL_MATH:**
  - a line without an amount adds nothing, so lines that all lack amounts give "Line items add up to 0.00…";
  - the 0.01 % uses |total|, so credit notes work;
  - the review suggested skipping that case, but I kept the task's literal rule (question 6).
- **NOT_AN_INVOICE** is skipped when `document_type` is null; EXTRACTION_FAILED covers that case.
- **NOT_BILLED_TO_CAMEX** treats a blank bill-to like a missing one.

**Evaluation**

- **No-op evaluations don't write.** `updated_at` then stays meaningful; the recovery sweep relies on it.
- **Post-commit evaluation failures are logged, not thrown.** The trigger's own write is already committed: an extraction, a vendor change. Throwing would only make pg-boss retry a job that then skips the invoice.
- **"Related" invoices** are any invoice with the same sha256 or invoice number key, in any status and for any vendor. That is a superset; the flag rules re-check every candidate.
  - The SQL prefilter strips the same whitespace as JS `\s` (`[[:space:]]` plus the Unicode spaces). The review found the no-break-space gap.
- **Vendor changes** run `evaluateWithRelated` per affected invoice. A new alias or domain can also change DUPLICATE_NUMBER for related invoices.
- **The daily run** uses plain `evaluate` per invoice.
- **`missed: 'once'` on the daily schedule.** If the app is down at 00:05, the next cron pass still sends that day's run.

**Link and trust**

- **Link when another vendor owns the extracted name** (changed after the review). The link goes through and no alias is added: the name stays with its owner, which is why the invoice matched that vendor in the first place. A 409 here would make a wrong automatic match impossible to correct without editing the other vendor (question 1).
  - Creating a vendor whose own name is taken is still a 409 (`field: 'create.name'`).
- **Linking again** to the same vendor records another manual `vendor_linked` event.
- **A deduplicated trust** writes no event and triggers no re-evaluation ("nothing changes").
- **Audit timestamps** (`added_at`, `removed_at`) use real time. The injected clock is for the business day only.

**Web**

- The vendor edit form sends only the fields that differ from the loaded vendor (changed after the review). Otherwise a save could overwrite an alias that a concurrent invoice link had just added.
- The tag input adds typed text on blur too, so a value isn't lost when going straight to Save.

**Tests**

- Tests for the shared helpers live in `apps/api/test/keys.test.ts`: `packages/shared` has no test runner, and I didn't add one.

## 5. How to verify

Prerequisites: Node 24+, pnpm 9+, Docker, an Anthropic API key. From a clean clone:

```sh
git clone <repo-url> camex && cd camex && git checkout t04-validation-vendors
cp .env.example .env
# edit .env: BOOTSTRAP_ADMIN_EMAIL=you@camex.aero, BOOTSTRAP_ADMIN_PASSWORD=<12+ chars>,
#            ANTHROPIC_API_KEY=<your key>, EXTRACTOR_PROVIDER=anthropic
pnpm install
docker compose up -d --wait            # Postgres :55432, MinIO :59000/:59001, healthy
pnpm db:migrate                        # 3 migrations; "All migrations have been successfully applied."
pnpm test                              # 23 files, 256 tests passed (~80 s); no API calls
pnpm lint && pnpm typecheck && pnpm build
pnpm eval:extraction                   # 3 × PASS, "passed: 3/3", exit 0 (about $0.06)
pnpm dev                               # API :3180 (workers on), web :5180
```

Then, signed in at http://localhost:5180 as the bootstrap admin (set a new password first):

1. `pnpm simulate:mailgun`. Within about 15 s the three invoices are `needs_review` on `/inbox`, each with flag counts. `GET /api/invoices/<id>` (with the session cookie) shows, relative to the real today:
   - **asm:** DISPUTE_SOON "Dispute window ended 2026-09-30" (warning), NEW_VENDOR (info).
   - **petrocas:** MISSING_REQUIRED `dueDate` (error), PAY_IN_OTHER_CURRENCY (info), NEW_VENDOR (info).
   - **aeg:** DISPUTE_SOON "…ended 2026-09-24", NEW_VENDOR.
2. On `/vendors`, add "Aviation Services Management FZE", "Petrocas Fuel Services Georgia LLC" and "AEG Fuels Ireland Limited". Each toast says "…and linked 1 invoice". The flags become:
   - asm and aeg: BANK_FIRST_SEEN · DISPUTE_SOON;
   - petrocas: MISSING_REQUIRED · BANK_FIRST_SEEN · PAY_IN_OTHER_CURRENCY.
3. `POST /api/invoices/<aeg id>/trust-bank-details` returns 200, with flags now `DISPUTE_SOON` only. Calling it again returns 200 and changes nothing.
4. On `/vendors`, open AEG and click Remove on the account, then confirm. The account moves to "Removed accounts", and the AEG invoice shows BANK_FIRST_SEEN again.

**What I actually ran**

- **Clean clone**, twice, as compose project `camex-invoices-check` in a temp directory, so it could run next to the dev stack:
  - Ports were remapped to 56432/60000/60001 and the API to 3181.
  - The `.env` came from `.env.example` with the bootstrap admin, `EXTRACTOR_PROVIDER=anthropic` and the key.
- **First run (`319255c`):** everything below passed, but the UI walkthrough found the edit-form bug (§7).
- **Final run (`522dcbf`, this commit without the report):**
  - The check project's volumes were removed first, so the database was empty.
  - `pnpm install --frozen-lockfile`, `up -d --wait`, `db:migrate` (3), `pnpm test` (256/256, 81 s), lint, typecheck (3/3) and build (3/3) all succeeded.
  - Then `NODE_ENV=production pnpm start` and steps 1–4 above (§6).
  - I drove steps 1 and 3 with a throwaway `fetch` script and steps 2 and 4 with headless Chromium (Playwright 1.63, installed outside the repo). Neither is committed.
  - Teardown: I stopped the server by its recorded process group, ran `docker compose -p camex-invoices-check down -v` (containers, network, volumes), and deleted the clone, including its `.env` with the key. The dev stack `camex-invoices` was not touched.
- I didn't repeat steps 1–4 against `pnpm dev` on the dev database. The dev database holds earlier T02/T03 test invoices, which would add duplicate flags, and I didn't want to reset it.

## 6. Test results

**`pnpm test`** (this machine and the clean clone): `Test Files 23 passed (23)`, `Tests 256 passed (256)`, about 80 s. That is the 139 T03 tests, some of them updated (below), plus 117 new ones: 13 keys and dates, 7 `deriveDates`, 41 `computeFlags` (including the fixture table), 23 vendor API, 25 evaluation, 1 normalization and 7 guard routes.

To check that the tests exercise the code they target, I made two temporary mutations, then restored the code:

- Related re-evaluation disabled: the two convergence tests, the both-commit test and the reject-clears test fail.
- The SQL whitespace class narrowed to `[[:space:]]`: the no-break-space test fails.

New tests (`pnpm --filter @camex/api exec vitest run --reporter=verbose …`):

```
✓ keys.test.ts > vendorKey > Petrocas Fuel Services Georgia LLC → petrocas fuel services georgia (task examples)
✓ keys.test.ts > vendorKey > Wells Fargo Bank, N.A. → wells fargo bank (task examples)
✓ keys.test.ts > vendorKey > შპს კამექს ეარლაინს → კამექს ეარლაინს (task examples)
✓ keys.test.ts > vendorKey > lowercases, removes punctuation and collapses whitespace
✓ keys.test.ts > vendorKey > removes trailing legal forms repeatedly, but only trailing ones
✓ keys.test.ts > vendorKey > removes a leading შპს or (Cyrillic) ООО, not a Latin one
✓ keys.test.ts > vendorKey > is empty for a legal form alone
✓ keys.test.ts > invoiceNumberKey > uppercases and removes spaces
✓ keys.test.ts > bankAccountKey > uses the normalized IBAN first
✓ keys.test.ts > bankAccountKey > else the account number without spaces, uppercase
✓ keys.test.ts > bankAccountKey > else null
✓ keys.test.ts > business dates > businessToday is the calendar day in Asia/Tbilisi (UTC+4)
✓ keys.test.ts > business dates > addDays and daysBetween work on calendar dates
✓ normalize.test.ts > normalization (wire → domain) > decimals: more than 14 integer digits (too big for numeric(18,4)) → null
✓ derive-dates.test.ts > deriveDates > keeps a printed due date, even when the terms disagree
✓ derive-dates.test.ts > deriveDates > keeps a manual due date
✓ derive-dates.test.ts > deriveDates > without one: invoice date + payment terms (source terms), before the vendor default
✓ derive-dates.test.ts > deriveDates > re-derives a previously derived date (terms, vendor_default) from the current inputs
✓ derive-dates.test.ts > deriveDates > else invoice date + the vendor default terms (source vendor_default)
✓ derive-dates.test.ts > deriveDates > else no due date and no source
✓ derive-dates.test.ts > deriveDates > dispute deadline = invoice date + dispute window, always derived, else null
✓ flags.test.ts > computeFlags > a clean invoice has no flags
✓ flags.test.ts > computeFlags > no flags at all while processing
✓ flags.test.ts > computeFlags > EXTRACTION_FAILED when the extraction failed
✓ flags.test.ts > computeFlags > MISSING_REQUIRED: one error per empty required field
✓ flags.test.ts > computeFlags > TOTAL_MATH > passes when the lines add up to the total, or to it with tax
✓ flags.test.ts > computeFlags > TOTAL_MATH > fails when neither sum matches
✓ flags.test.ts > computeFlags > TOTAL_MATH > is skipped without line items or without a total
✓ flags.test.ts > computeFlags > TOTAL_MATH > tolerance: 0.05 absolute
✓ flags.test.ts > computeFlags > TOTAL_MATH > tolerance: 0.01 % of the total when that is larger
✓ flags.test.ts > computeFlags > TOTAL_MATH > uses exact decimals, not floats
✓ flags.test.ts > computeFlags > LINE_MATH > flags each line whose quantity × unit price is off, by its path
✓ flags.test.ts > computeFlags > LINE_MATH > needs quantity, unit price and amount
✓ flags.test.ts > computeFlags > LINE_MATH > tolerance against the line amount: 0.05, or 0.01 % when larger
✓ flags.test.ts > computeFlags > DUE_BEFORE_INVOICE when the due date is before the invoice date
✓ flags.test.ts > computeFlags > TERMS_MISMATCH only for a printed due date with terms
✓ flags.test.ts > computeFlags > DUE_DATE_DERIVED for terms and vendor_default, not printed or manual
✓ flags.test.ts > computeFlags > FUTURE_DATE when the invoice date is after today
✓ flags.test.ts > computeFlags > SERVICE_AFTER_INVOICE when the service date is after the invoice date
✓ flags.test.ts > computeFlags > PAY_IN_OTHER_CURRENCY when the amount due is in another currency
✓ flags.test.ts > computeFlags > NOT_BILLED_TO_CAMEX unless the bill-to contains "camex"; also when there is none
✓ flags.test.ts > computeFlags > NOT_AN_INVOICE for anything but an invoice or credit note
✓ flags.test.ts > computeFlags > duplicates > DUPLICATE_FILE: same sha256 on another non-rejected invoice, in any status
✓ flags.test.ts > computeFlags > duplicates > DUPLICATE_NUMBER: same number key and the same vendor_id
✓ flags.test.ts > computeFlags > duplicates > DUPLICATE_NUMBER: equal vendorKey(vendor_name) when either side is unlinked
✓ flags.test.ts > computeFlags > NEW_VENDOR without a vendor (and no bank flags then)
✓ flags.test.ts > computeFlags > bank details > BANK_FIRST_SEEN: linked vendor without active trusted accounts
✓ flags.test.ts > computeFlags > bank details > BANK_UNKNOWN: the vendor has trusted accounts and none matches
✓ flags.test.ts > computeFlags > bank details > matches by key (spaces and case ignored); account number when there is no IBAN
✓ flags.test.ts > computeFlags > bank details > no bank flag without an IBAN or account number
✓ flags.test.ts > computeFlags > DISPUTE_SOON > in 3 days (or less): "ends"
✓ flags.test.ts > computeFlags > DISPUTE_SOON > already passed: "ended"
✓ flags.test.ts > computeFlags > DISPUTE_SOON > only in needs_review
✓ flags.test.ts > computeFlags > orders errors, then warnings, then info (SPEC table order within a severity)
✓ flags.test.ts > computeFlags > messages never contain bank account numbers
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > asm, no vendors: DISPUTE_SOON (ended 2026-09-30) · NEW_VENDOR
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > asm, vendor without trusted accounts: BANK_FIRST_SEEN · DISPUTE_SOON
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > petrocas, no vendors: MISSING_REQUIRED dueDate · PAY_IN_OTHER_CURRENCY · NEW_VENDOR
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > petrocas, vendor with default terms 10: due 2026-10-12 (vendor_default); BANK_FIRST_SEEN · DUE_DATE_DERIVED · PAY_IN_OTHER_CURRENCY
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > aeg, no vendors: DISPUTE_SOON (ended 2026-09-24) · NEW_VENDOR
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > aeg, vendor without trusted accounts: BANK_FIRST_SEEN · DISPUTE_SOON
✓ flags.test.ts > fixtures (golden files, today 2026-10-02) > after trusting AEG's account, a second AEG invoice with another account number gets BANK_UNKNOWN; the first has no bank flag
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > creates a vendor; domains lowercased, repeated aliases and domains dropped
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > lists vendors sorted by name with counts; search matches name, alias or domain
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > openInvoiceCount counts needs_review and unpaid invoices
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > updates any field; terms can be cleared with null
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > validates input: 400 for bad names, terms, domains and empty updates
✓ vendors.e2e.test.ts > vendors API > create, read, update, search > rejects public mailbox domains and Camex domains (incl. subdomains) with 400
✓ vendors.e2e.test.ts > vendors API > 409: names, aliases and domains are unique across vendors > a name equal (by key) to another vendor’s name
✓ vendors.e2e.test.ts > vendors API > 409: names, aliases and domains are unique across vendors > a name equal to another vendor’s alias
✓ vendors.e2e.test.ts > vendors API > 409: names, aliases and domains are unique across vendors > an alias equal to another vendor’s name or alias, with its index
✓ vendors.e2e.test.ts > vendors API > 409: names, aliases and domains are unique across vendors > a domain of another vendor
✓ vendors.e2e.test.ts > vendors API > 409: names, aliases and domains are unique across vendors > PATCH checks against the other vendors only
✓ vendors.e2e.test.ts > vendors API > creating or changing a vendor re-evaluates invoices > creating a vendor links pending invoices by name and updates their flags
✓ vendors.e2e.test.ts > vendors API > creating or changing a vendor re-evaluates invoices > a new alias or domain links on update; default terms re-derive due dates
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > links an existing vendor and adds the extracted name as an alias
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > adds no alias when the vendor already answers to the extracted name
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > creates a vendor and links it; the new vendor also links other pending invoices
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > corrects a wrong match: the extracted name stays with the vendor that owns it
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > 409 outside needs_review
✓ vendors.e2e.test.ts > vendors API > POST /api/invoices/:id/vendor > 400 for a bad body, 404 for an unknown invoice or vendor
✓ vendors.e2e.test.ts > vendors API > trusted bank accounts > trusting adds the account (who, when, which invoice) and updates the vendor’s open invoices
✓ vendors.e2e.test.ts > vendors API > trusted bank accounts > trusting the same account again changes nothing and is 200
✓ vendors.e2e.test.ts > vendors API > trusted bank accounts > works on unpaid invoices; 409 in other statuses, without a vendor or without bank details
✓ vendors.e2e.test.ts > vendors API > trusted bank accounts > removal is soft and idempotent; the flag comes back
✓ evaluation.e2e.test.ts > invoice evaluation > the fixtures end to end (T04 "Done when", with the clock at 2026-10-02) > no vendors → name match on vendor creation → trust clears → removal brings it back
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > by name, ignoring case, punctuation and legal forms
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > by alias
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > by the sender’s email domain when the name doesn’t match
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > a name match beats a domain match
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > manual uploads never match by domain
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > own domains (and their subdomains) never match
✓ evaluation.e2e.test.ts > invoice evaluation > vendor matching > only unlinked invoices in needs_review are matched
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > the same PDF twice: both DUPLICATE_FILE; rejecting one clears the other
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > a duplicate file counts in any status, including paid
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > same vendor + number: both DUPLICATE_NUMBER; another vendor with the same number: none
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > numbers match by key: case and any whitespace (incl. no-break spaces) ignored
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > linked to the same vendor counts; linked to different vendors does not
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > convergence when two duplicates finish extraction at the same time > A commits first: whichever commits last re-flags the other
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > convergence when two duplicates finish extraction at the same time > B commits first: whichever commits last re-flags the other
✓ evaluation.e2e.test.ts > invoice evaluation > duplicates > convergence when two duplicates finish extraction at the same time > also when both commit before either evaluates, in either evaluation order
✓ evaluation.e2e.test.ts > invoice evaluation > daily re-evaluation > moving the clock flips DISPUTE_SOON
✓ evaluation.e2e.test.ts > invoice evaluation > daily re-evaluation > covers needs_review and unpaid invoices only; FUTURE_DATE flips too
✓ evaluation.e2e.test.ts > invoice evaluation > daily re-evaluation > leaves unchanged invoices untouched (no write, updated_at kept)
✓ evaluation.e2e.test.ts > invoice evaluation > extraction triggers evaluation > after success: vendor, derived dates and flags are set
✓ evaluation.e2e.test.ts > invoice evaluation > extraction triggers evaluation > after a non-retryable failure: EXTRACTION_FAILED and MISSING_REQUIRED
✓ evaluation.e2e.test.ts > invoice evaluation > extraction triggers evaluation > after the final retryable attempt fails, and a failed invoice can still match by domain
✓ evaluation.e2e.test.ts > invoice evaluation > extraction triggers evaluation > after the recovery sweep gives up
✓ evaluation.e2e.test.ts > invoice evaluation > extraction triggers evaluation > a processing invoice has no flags
✓ evaluation.e2e.test.ts > daily re-evaluation schedule (workers on) > is registered at 00:05 Asia/Tbilisi
```

**Changes to T03 tests**

- `extraction.e2e`:
  - waits until the invoice is evaluated, not just `needs_review`;
  - expects the stub's flags and the derived dispute deadline;
  - waits for the job's final state before checking `failed` (see §7).
- `invoices.e2e`: pins the clock and expects `vendor`, `dueDateSource`, `disputeDeadline` and the ASM flags.
- `inbox.e2e`: expects `flags: []` on a processing invoice.
- `eval-score`: the name assertions use `vendorKey`.
- `guard.e2e` covers the seven new routes.

**`pnpm eval:extraction`** (CTO decision 5, one run, after the `decimal()` and scorer changes):

```
Extraction eval · model claude-sonnet-5-5 · prompt extract-v1 · 3 fixture(s) × 1 run(s)
aeg: PASS · claude-sonnet-5-5 · 6485 in / 919 out tokens · 5.9 s
asm: PASS · claude-sonnet-5-5 · 6059 in / 592 out tokens · 5.1 s
petrocas: PASS · claude-sonnet-5-5 · 5760 in / 578 out tokens · 5.2 s
Summary
  passed: 3/3 · aeg 1/1, asm 1/1, petrocas 1/1
  tokens: 18304 in / 2089 out in total · per invoice 6101 in / 696 out
  duration per invoice: avg 5.4 s · min 5.1 s · max 5.9 s
  est. cost per invoice: $0.0192 (claude-sonnet-5-5: $2/$10 per MTok in/out)
```

**Scorer check.** The T03 scorer from `main` and the `vendorKey` one, on this run's normalized outputs (`eval-out/`), gave identical scores: 0 mismatches each for aeg, asm and petrocas. They also agree on all 12 name pairs from the T03 report and the scorer tests.

**"Done when" in the clean clone (final run)**, real extraction, today = 2026-10-04. The output is condensed: `[UI]` lines come from the Playwright script, and text after `→` is my annotation.

```
all 3 in needs_review with flags after 12.4 s (polling from after the simulator)
aeg.pdf      vendor null · due 2026-09-21 (printed) · dispute deadline 2026-09-24
   DISPUTE_SOON(warning, disputeDeadline): Dispute window ended 2026-09-24
   NEW_VENDOR(info, vendorName): No vendor matched: link an existing vendor or create one
petrocas.pdf vendor null · due null (null) · dispute deadline null
   MISSING_REQUIRED(error, dueDate): Due date is missing
   PAY_IN_OTHER_CURRENCY(info, amountDueCurrency): Payable in GEL; the invoice is priced in USD
   NEW_VENDOR(info, vendorName): No vendor matched: link an existing vendor or create one
asm.pdf      vendor null · due 2026-09-16 (printed) · dispute deadline 2026-09-30
   DISPUTE_SOON(warning, disputeDeadline): Dispute window ended 2026-09-30
   NEW_VENDOR(info, vendorName): No vendor matched: link an existing vendor or create one

[UI] toast: Added Aviation Services Management FZE and linked 1 invoice
[UI] toast: Added Petrocas Fuel Services Georgia LLC and linked 1 invoice
[UI] domain error: A public mailbox domain can't identify a vendor
[UI] toast: Added AEG Fuels Ireland Limited and linked 1 invoice
[UI] 409 inline: Vendor "AEG Fuels Ireland Limited" already uses the name "AEG FUELS IRELAND LTD"
Step 2: after creating the three vendors on /vendors
  aeg.pdf       vendor AEG Fuels Ireland Limited · BANK_FIRST_SEEN/warning@bankDetails.accountNumber, DISPUTE_SOON/warning@disputeDeadline
  petrocas.pdf  vendor Petrocas Fuel Services Georgia LLC · MISSING_REQUIRED/error@dueDate, BANK_FIRST_SEEN/warning@bankDetails.iban, PAY_IN_OTHER_CURRENCY/info@amountDueCurrency
  asm.pdf       vendor Aviation Services Management FZE · BANK_FIRST_SEEN/warning@bankDetails.iban, DISPUTE_SOON/warning@disputeDeadline
Step 3: POST /api/invoices/<aeg>/trust-bank-details → 200; flags now: DISPUTE_SOON
        again → 200 (dedupe)
[UI] confirm dialog: Remove this trusted account? | Open invoices from AEG Fuels Ireland Limited that pay into 4942312687 will be flagged again …
[UI] removed card: … | Trusted by Admin · 4 Oct 2026, 17:36 | From invoice | Removed by Admin · 4 Oct 2026, 17:36
[UI] PATCH body: {"aliases":["AEG Fuels","Aviation Services Management"]}  → 409 shown inline on Aliases
[UI] chips after Discard: [ 'Remove AEG Fuels', 'Remove aegfuels.example' ]
[UI] PATCH body: {"defaultPaymentTermsDays":7}  → saved
Step 4: after removing the account on /vendors, aeg.pdf flags: BANK_FIRST_SEEN/warning, DISPUTE_SOON/warning
        vendor: activeBankAccountCount 0, bankAccounts 1 (removedAt set: true), terms 7
```

- **Events in the database:**
  - three `vendor_linked` events with `user_id` null and `{method: "name", vendorId}`;
  - one `bank_account_trusted` with the user and `{vendorId, accountId}`.
- **Other UI checks:**
  - The Inbox chips showed the counts ("Flags: 1 error, 2 notes"), and the tooltip listed the codes.
  - Search "aegfuels" found 1 row.
  - At 390 px wide there was no horizontal overflow, on the page or with the sheet open.
  - No page errors. The only console errors were the network log lines for the pre-login `401` and the deliberate `409`.
- **Log scan (144 lines):** the account, IBAN, routing and SWIFT values of all three invoices, both admin passwords, `sk-ant` and `%PDF` occur 0 times.

`pnpm lint` → ESLint clean, `All matched files use Prettier code style!`. `pnpm typecheck` → 3 × `Done`. `pnpm build` → 3 × `Done`.

## 7. Known issues / shortcuts

**Found and fixed during verification**

- **Vendor edit form, Discard didn't revert.** After a failed save, Discard didn't remove an added alias chip, and the next save sent it again (409 again).
  - Cause: react-hook-form 7.89 merges the form's `resetOptions` (`keepDirtyValues: true`, used so a refetch keeps unsaved edits) into every explicit `reset()`.
  - Fix: explicit resets pass `keepDirtyValues: false`. Verified in the final clean-clone run.
- **Race in a T03 test.** `retryable errors get 3 attempts…` read the pg-boss job state the moment the invoice became `needs_review`. The handler now evaluates the invoice before it rethrows, so once in a full run the job was still `active`. The test now waits for the job's final state, as the non-retryable test already did. 3 consecutive full runs passed afterwards.

**Open**

- **One unexplained one-off failure.** In one full run, `mailgun.e2e › rejects a missing token with 401 and stores nothing` failed. My output filter dropped the assertion detail. It didn't recur in 3 runs of that file or in 4 later full runs (3 here, 1 in the clean clone). The test only checks that nothing is stored on a 401. I didn't find a T04 cause.
- **A brief flagless window** sits between the extraction commit and its evaluation: milliseconds, but the Inbox poll can catch it.
- **For T06: invoice-number edits.** An edit that changes the invoice number must also re-evaluate invoices that shared the old number. `evaluateWithRelated` relates by the current number only. Rejecting already works, because the other invoices are found by sha256 and number, which don't change.
- **Casing in the SQL prefilter.** The duplicate-number prefilter uses Postgres `upper()`, which differs from JS `toUpperCase()` for a few characters (`ß`). Such numbers could miss DUPLICATE_NUMBER. Whitespace now matches JS.
- **Vendor changes re-evaluate synchronously** in the request, one transaction per affected invoice (the vendor's open invoices, plus every unlinked `needs_review` invoice on a rematch). Fine at v1 volumes.
- **Invoices extracted before T04** (dev database only) keep `flags: []` until the next daily run or a change.
- **The "From invoice" link** goes to `/invoices/:id`, which 404s until T06, as the task says.
- **No automated web tests.** The UI was checked with a Playwright script kept outside the repo.
- **Georgian bill-to names.** A bill-to printed only in Georgian ("შპს კამექს ეარლაინს") gets NOT_BILLED_TO_CAMEX, because the rule is a "camex" substring (question 2).
- **Local environment (not code):** the dev `.env` and the dev database were not changed, apart from the new migration applied by `pnpm db:migrate:dev`. `docs/tasks/T07-deploy.md` is untracked and not part of this commit.

## 8. Questions for the CTO

1. **Linking to a vendor when another vendor owns the extracted name.** I link without adding the alias. The literal alternative is a 409, but then a wrong automatic match can only be fixed by editing the other vendor's names. OK as implemented?
2. **NOT_BILLED_TO_CAMEX and Georgian bill-to names.** Should "კამექს" (Camex in Georgian) also count, given the prompt already names Camex in Georgian?
3. **Flag order within a severity.** It is SPEC table order, so BANK_FIRST_SEEN comes before DISPUTE_SOON. Should time-critical warnings come first instead?
4. **Vendor email domains match exactly.** Should `mail.aegfuels.com` match a vendor domain `aegfuels.com`?
5. **Evaluation inside the extraction transaction.** Should the extraction write also evaluate inside its own transaction, so a `needs_review` invoice never exists without flags? The post-commit `evaluateWithRelated` would still run for convergence. It costs one extra evaluation per extraction.
6. **TOTAL_MATH when no line has an amount.** It currently fires ("Line items add up to 0.00…"). Keep that, or skip as for LINE_MATH?

## 9. `git diff --stat main...HEAD`

```
 .env.example                                       |   5 +-
 README.md                                          |   6 +
 .../migration.sql                                  |   8 +
 apps/api/prisma/schema.prisma                      |  23 +-
 apps/api/src/app.module.ts                         |   4 +
 apps/api/src/clock/clock.module.ts                 |  13 +
 apps/api/src/config/env.ts                         |  11 +-
 apps/api/src/evaluation/derive-dates.ts            |  51 ++
 apps/api/src/evaluation/email-domains.ts           |  16 +
 apps/api/src/evaluation/evaluation.module.ts       |  10 +
 apps/api/src/evaluation/evaluation.workers.ts      |  42 +
 apps/api/src/evaluation/flags.ts                   | 334 ++++++++
 apps/api/src/evaluation/invoice-evaluator.ts       | 349 ++++++++
 apps/api/src/extraction/eval/score.ts              |  21 +-
 apps/api/src/extraction/extraction.handler.ts      |  23 +-
 apps/api/src/extraction/extraction.module.ts       |   2 +
 apps/api/src/extraction/normalize.ts               |   9 +-
 apps/api/src/extraction/recovery-sweep.ts          |   7 +-
 apps/api/src/inbox/inbox.service.ts                |  10 +-
 apps/api/src/invoices/invoice-columns.ts           |   4 +-
 apps/api/src/invoices/invoices.module.ts           |   1 +
 apps/api/src/invoices/invoices.service.ts          |  11 +-
 apps/api/src/vendors/bank-accounts.ts              |  66 ++
 apps/api/src/vendors/invoice-vendor.controller.ts  |  35 +
 apps/api/src/vendors/invoice-vendor.service.ts     | 172 ++++
 apps/api/src/vendors/vendor-rules.ts               | 121 +++
 apps/api/src/vendors/vendors.controller.ts         |  60 ++
 apps/api/src/vendors/vendors.module.ts             |  14 +
 apps/api/src/vendors/vendors.service.ts            | 233 ++++++
 apps/api/test/derive-dates.test.ts                 |  95 +++
 apps/api/test/eval-score.test.ts                   |  13 +-
 apps/api/test/evaluation.e2e.test.ts               | 527 ++++++++++++
 apps/api/test/extraction.e2e.test.ts               |  41 +-
 apps/api/test/flags.test.ts                        | 910 +++++++++++++++++++++
 apps/api/test/guard.e2e.test.ts                    |  10 +
 apps/api/test/helpers.ts                           |  82 ++
 apps/api/test/inbox.e2e.test.ts                    |   1 +
 apps/api/test/invoices.e2e.test.ts                 |  24 +-
 apps/api/test/keys.test.ts                         |  97 +++
 apps/api/test/normalize.test.ts                    |  12 +
 apps/api/test/vendors.e2e.test.ts                  | 635 ++++++++++++++
 apps/web/src/components/flag-counts.tsx            |  77 ++
 apps/web/src/components/tag-input.tsx              | 111 +++
 apps/web/src/components/ui/tooltip.tsx             |  54 ++
 apps/web/src/pages/inbox/invoice-chip.tsx          |  30 +-
 apps/web/src/pages/vendors/add-vendor-dialog.tsx   |  87 ++
 apps/web/src/pages/vendors/vendor-fields.tsx       | 136 +++
 apps/web/src/pages/vendors/vendor-form.ts          | 108 +++
 apps/web/src/pages/vendors/vendor-sheet.tsx        | 310 +++++++
 apps/web/src/pages/vendors/vendors-page.tsx        | 170 ++++
 apps/web/src/pages/vendors/vendors-query.ts        |  73 ++
 apps/web/src/router.tsx                            |  10 +-
 docs/SPEC.md                                       |  47 +-
 docs/reports/T04-validation-vendors.md             | 540 ++++++++++++
 docs/tasks/T04-validation-vendors.md               | 205 +++++
 packages/shared/src/common.ts                      |   4 +
 packages/shared/src/dates.ts                       |  43 +
 packages/shared/src/inbox.ts                       |   4 +-
 packages/shared/src/index.ts                       |   3 +
 packages/shared/src/invoices.ts                    |  46 +-
 packages/shared/src/keys.ts                        |  74 ++
 packages/shared/src/vendors.ts                     | 153 ++++
 62 files changed, 6287 insertions(+), 106 deletions(-)
```
