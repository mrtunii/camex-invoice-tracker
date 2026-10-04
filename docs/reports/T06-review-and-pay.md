# T06 — Invoice detail: review, approve, pay

Branch `t06-review-and-pay`, one commit "T06: review and pay". Not merged, not pushed.

## 0. Git (§0)

`main` was at `a7fe5b8` (= `origin/main`). The only untracked file was `docs/tasks/T06-review-and-pay.md`; it is committed with T06.

| Command                                | Output                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `git checkout main`                    | `Switched to branch 'main'` · `Your branch is up to date with 'origin/main'.`                              |
| `git pull --ff-only`                   | `Already up to date.`                                                                                      |
| `git merge --ff-only t05b-ui-overhaul` | `Updating a7fe5b8..3c3881c` · `Fast-forward` · `114 files changed, 10991 insertions(+), 9750 deletions(-)` |
| `git push origin main`                 | `To github.com:mrtunii/camex-invoice-tracker.git` · `a7fe5b8..3c3881c  main -> main`                       |
| `git checkout -b t06-review-and-pay`   | `Switched to a new branch 't06-review-and-pay'`                                                            |

## 1. Summary

- **The full loop works in the browser**: received → reviewed and corrected → approved (creating the vendor and trusting its bank details in the approve dialog) → paid, every step in Activity. All seven walkthrough paths pass (27 checks, §6.3), plus 12 checks of the PDF viewer, keyboard save and the leave guard.
- **API:** one state machine module (`apps/api/src/invoices/workflow/`): the transition table as data, one service applying it. Every action runs in one transaction with a row lock, checks `version` (409 `STALE`) and status (409 `INVALID_TRANSITION`), writes its event with the user and re-evaluates; related invoices are re-evaluated after commit, including those that shared the **old** invoice number (the T04 known issue). Approve's 409s `MISSING_REQUIRED` / `VENDOR_REQUIRED` / `CONFIRM_REQUIRED`, trust in the same transaction, mark paid with confirm, reject / re-extract / undo payment / reopen, `PATCH` with normalization and a changed-fields-only `edited` diff, `GET …/events`, `GET …/next-to-review`.
- **Web:** `/invoices/:id` is the split view (react-resizable-panels, ratio remembered) with the PDF (react-pdf / pdf.js) left and the review pane right; tabs below 1024 px. Header, issues that focus their field, the form in review order with "Extracted: … · Restore", read-only definition list outside `needs_review`, payment details with copy buttons, source email, activity in sentences, a sticky action bar per status, and the approve / mark paid / reject / re-extract / link-vendor / leave dialogs. Ctrl/Cmd+S saves; a 409 STALE keeps the edits and offers Reload.
- **T05b follow-ups (0b):** all nine handled (§2.5). Atkinson Hyperlegible Next has **no plain-zero alternate**, so the slashed zero stays.
- **Found during QA and fixed** (§7), among others: toasts covered the Approve button; amounts from the database ("2298.5") showed as edited against the extraction ("2298.50"); and the pdf.js worker would have been served by production nginx as `application/octet-stream` (no `.mjs` in its MIME map), which browsers refuse for a module worker.
- **Tests:** API 364/364 in 29 files (328 before; new `workflow.e2e.test.ts` with 26 tests, plus updated vendor, evaluation, guard, flags, invoices, dashboard and seed tests). Web 59/59 (33 before; activity sentences, line totals, the form model). Lint, typecheck and build are clean in the working tree and in a clean clone (§6).
- **Dependencies:** `react-pdf` 11.0.0 (pdfjs-dist 6.3.289) and `react-resizable-panels` 4.14.2, nothing else.
- **Built in two parallel tracks:** I wrote the shared contract first (`packages/shared/src/invoice-workflow.ts`, `normalize.ts`, the detail additions), then a sub-agent forked from my context built the API half and its tests while I built the web half. I reviewed its workflow service, guard, edit diffing and trust helper, and re-ran every suite myself.

## 2. What was built

### 2.1 Shared contract (`packages/shared`)

- `invoice-workflow.ts`: `updateInvoiceRequestSchema` (version + any editable field in the domain shape; each field validated **and normalized** with the extraction's rules, a value a rule can't read is a 400 with a message per field: "Use at most 4 decimals", "Enter a real date", "Use a 3-letter code like USD"), the action schemas (approve, reject with "note required for other", mark paid, version-only), the 409 body (`workflowConflictSchema`, `STALE_MESSAGE`), `nextToReview`, the events response and the event data shapes.
- `normalize.ts`: the T03 field rules moved out of `apps/api/src/extraction/normalize.ts` (which now delegates), so edits, the extraction and the web form normalize identically ("4lcmx" → "4L-CMX", "CMS503/4" → CMS503, CMS504, IBAN/SWIFT compaction, uppercase codes, real dates, decimals within numeric(18,4)).
- `invoices.ts`: the detail gains `version`, approval / payment / rejection fields with user names, `extracted` (`normalizeExtraction(extraction_raw)`, null unless the extraction succeeded) and `email` (from, subject, received, uploaded by, ignored attachments). `vendors.ts`: link and trust carry `version`. `invoice-list.ts`: the `extraction=failed` filter. `dates.ts`: `humanDate` ("6 Oct 2026").

### 2.2 API (`apps/api`)

- **Migrations:** `invoices.version int not null default 0`; `invoice_events.created_at` defaults to `clock_timestamp()` instead of `now()`, so events written in one transaction (trust + approve, an edit and the vendor match it causes) keep their order in Activity.
- **`invoices/workflow/`:** `transitions.ts` (the table: from, to, event, wording of the refusal), `workflow-guard.ts` (row lock → 404 → version → status, and the 409 builders), `invoice-edit.ts` (changed fields in the domain shape, amounts compared by value; the columns they write; `dueDate` set → `manual`, cleared → null and re-derived), `workflow.service.ts` (one `transition()` applying the table), controller and module.
- **Approve:** re-evaluates first, then required fields (never overridable, even with `confirmErrors`), then the vendor, then error flags — all **before** `trustBankDetails`, so trusting can't clear a BANK_UNKNOWN. Trust shares `vendors/trust-bank-details.ts` with the T04 endpoint (vendors locked before the invoice, as in T04). `approved {overriddenFlags}`.
- **Mark paid:** paid date ≤ today in Tbilisi (400 otherwise), re-evaluated first, error flags need `confirmErrors`. `paid {paidAt, reference, overriddenFlags}`.
- **Re-extract:** `processing` + `extraction_status = pending`, version bumped, job enqueued after commit; the extraction overwrites every field (edits too) and resets the due date source, and keeps the vendor link. A re-extraction that changes the invoice number re-evaluates the invoices sharing the old one.
- **Reads:** `GET …/events` (newest first, `{id, type, at, user, vendor, data}`; `vendor` resolved from `data.vendorId`), `GET …/next-to-review?after=`, the detail fields of §2.1.
- **T04 endpoints:** `POST …/vendor` and `POST …/trust-bank-details` require `version` (STALE on mismatch) and bump it.
- **0b:** flag messages with human dates; `extraction=failed` on list, summary and CSV; the dashboard's 12 months end at the requested month.
- **`seed:demo`:** the unmatched Kolkhi invoice now carries fictional bank details, and an ASM reminder (same PDF, same number) waits in To review as a duplicate, so the walkthrough has a vendor to create, details to trust and a duplicate to reject. 29 invoices: 5 to review, 6 to pay, 17 paid, 1 rejected.

### 2.3 Web (`apps/web/src/pages/invoices/detail/`)

- `invoice-detail-page.tsx`: loading, 404, the split view (≥ 1024 px, `useDefaultLayout` in localStorage, guarded for private mode) or tabs; the save / approve / approve & next / undo flows; STALE handling (a newer version arriving while there are edits shows the banner before the save is even tried); the unsaved-changes guard (`useBlocker` + `beforeunload`); Ctrl/Cmd+S. The route is full-bleed (`handle.fullBleed`): the shell drops its padding and max width for it.
- `pdf-viewer.tsx` (its own lazy chunk): one page at a time, fit width by default, page navigation, zoom (with the percentage of actual size), rotate, download (through `apiDownload`), open in a new tab; text layer on, annotation layer off (no clickable links from vendor PDFs); a plain message with Download if the file can't be rendered. Loaded with `withCredentials`.
- `form-model.ts` (pure, tested): form values ↔ API; the PATCH body is the changed fields only, normalized with the shared schemas, so "4lcmx" isn't a change and "12,5" is refused at its field before sending; amounts are shown with two decimals and compared by value; what differs from the extraction (a derived due date doesn't count).
- `review-form.tsx`, `line-items-editor.tsx` (two rows per line so amounts stay visible in the ~500 px pane; live total and difference), `invoice-facts.tsx` (read-only), `invoice-header.tsx` + `state-line.ts`, `side-sections.tsx` (issues, payment details, source email, activity), `action-bar.tsx`, `action-dialogs.tsx`, `vendor-linker.tsx`, `detail-query.ts`.
- `lib/activity.ts` (pure, tested): events → sentences. "Otto changed Amount due from 6,461.29 to 6,416.29"; several fields are listed with one line each; bank details and line items are summarised ("changed bank details: IBAN and SWIFT", "line items (1 line → 2)") with the values behind Show; "Matched to AEG Fuels by name"; "Nino approved despite a duplicate invoice number" (codes never appear).
- `lib/line-items.ts` (pure, tested): exact decimal sums on strings (BigInt), the difference from the total, matching with or without the tax like TOTAL_MATH, with its tolerance.

### 2.4 Docs

SPEC §5 (`version`, event ordering), §6 (the table with edit, the vendor requirement, confirmation on approve and mark paid, version conflicts, re-extract keeps the vendor link, the 409 shapes, the workflow module), §8 (human dates in messages), §10 (the detail page as built; Home's chart window and the `extraction=failed` link; the list's switch). README: a "Reviewing and paying an invoice" section; the interim-page and "UI comes in T06" notes are gone.

### 2.5 T05b follow-ups (0b)

| #                      | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Mobile chart        | **Not reproduced**, but the cause is removed. T05b's 390 px screenshot shows the SVG drawn at ~45 % of its box. I could not reproduce that on `main` or on this branch: direct load, a resize from 1440, the drawer, dark theme, a full-page capture 250 ms after network idle, and a per-frame recorder from navigation on all gave an SVG exactly the size of its 324×224 box. The chart no longer uses Recharts' `ResponsiveContainer`: it measures its box (`useElementWidth`, a ResizeObserver) and draws at exactly that width and 224 px. Screens `30-home-390-*`. |
| 2. Slashed zeros       | **Kept: there is no plain-zero alternate.** I read the font tables with fontTools. Fontsource's Atkinson Hyperlegible Next has only `ccmp frac locl pnum tnum`, and the upstream Google Fonts file (v2.001) has only `aalt case ccmp frac locl ordn pnum sups tnum`. The only zero glyphs are `zero` (3 contours: slashed) and `zero.tf` (a composite of it). There is no `zero`, `salt`, `ss01`… or `cv01`… feature to switch to. Atkinson Hyperlegible Mono has the same single slashed zero.                                                                           |
| 3. Invoice numbers     | Never truncated: they wrap at their separators ("PFSG-CAM-" / "00000000510"; Unicode line breaking forbids a break between a hyphen and digits, so `<wbr>` is placed after `- / _ .`), anywhere as a last resort. Inbox file names wrap the same way. Vendor names still wrap to two lines. Screens `32-invoices-all-*`.                                                                                                                                                                                                                                                  |
| 4. Ledger on desktop   | Ledger and chart share a row from 1024 px (5 : 7); the ledger table fills its panel; categories and vendors below in two columns. Phones keep amount and count on one line, the count smaller and muted. Screens `30-home-*`, `31-home-september-*`.                                                                                                                                                                                                                                                                                                                      |
| 5. Caution             | Light caution is `#A15F00` (oklch 54.8 % 0.1231 64.83): 4.63:1 on the canvas, 5.06:1 on white.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6. Chart window        | 12 months ending at the picked month ("12 months to September 2026"; "Last 12 months" for the current month); the currency list and default come from the same window; the picked month's label is in ink, "This month" stays under the current month when shown.                                                                                                                                                                                                                                                                                                         |
| 7. `extraction=failed` | List, summary and CSV filter; in the URL; a "Couldn't be read" switch shows while it applies (to clear it); Clear filters removes it; the status sentence links to it. Screen `33-couldnt-be-read`.                                                                                                                                                                                                                                                                                                                                                                       |
| 8. Flag messages       | "Dispute window ends 6 Oct 2026", "Due date 1 Oct 2026 is before the invoice date 5 Oct 2026", etc. Messages are rewritten on each evaluation; no backfill.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9.                     | Bundle accepted; passed dispute windows stay out of the sentence (SPEC §10 says so now).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 2.6 Dependencies

- **react-pdf 11.0.0** (MIT): the current release; peer `react ^19`, `react-dom ^19`; renders with pdfjs-dist 6.3.289. Chosen over raw pdf.js for its React lifecycle (cancellation on page/zoom changes, text layer). Its worker comes from pdfjs-dist, which pnpm doesn't expose to the app: `vite.config.ts` resolves `pdfjs-dist` **through react-pdf** (an alias), so the worker is always the version react-pdf runs, and the worker is emitted as `.js` (§7.3).
- **react-resizable-panels 4.14.2** (MIT): the split; peer `react ^18 || ^19`; keyboard-resizable separator, `useDefaultLayout` for persistence.

Chunk sizes (gzip -9): the detail page 131.6 kB (38.5 kB gz); the PDF viewer 633.2 kB (188.5 kB gz), loaded lazily by the detail page only; the pdf.js worker 1,265 kB (373.6 kB gz), fetched by the browser when a PDF opens. pdf.js's main module can't be split, so `build.chunkSizeWarningLimit` is 700 kB (with the reason in the config); every other chunk is under 500 kB.

## 3. Deviations (with reasons)

1. **No `isEvalSupported: false`.** pdf.js 6.3.289 removed the option together with its eval code paths; it isn't in `DocumentInitParameters`. I checked the shipped `pdf.mjs`, `pdf.min.mjs` and both worker builds: no `eval(` and no `new Function` (the one grep hit is `new FunctionBasedShading`).
2. **pdfjs-dist through a Vite alias, not hoisting.** react-pdf's README suggests `public-hoist-pattern[]=pdfjs-dist` for pnpm < 11; applying it makes pnpm stop and ask to remove and reinstall `node_modules`. The alias needs no install change and pins the worker to react-pdf's own pdf.js.
3. **Link vendor and trust bank details carry `version` too** (the task names edits and transitions). Both are human writes on the invoice, and trust targets the account the person looked at: without the check, an IBAN edited in between would be trusted unseen. They bump the version like any write.
4. **The mobile chart bug** couldn't be reproduced (0b #1); I removed the mechanism instead of fixing a reproduction.
5. **"Dispute window closes Tue 6 Oct"** in the header, not "ends": the same words Home and the list use for that date since T05b. Flag messages (written by the API) say "ends".

## 4. Decisions not in the spec

1. **The approve dialog links the vendor immediately** (the T04 endpoint), then shows the steps that follow from the new flags (a new vendor has no trusted accounts → BANK_FIRST_SEEN; an existing one may match or give BANK_UNKNOWN). Cancelling after linking keeps the link.
2. **EXTRACTION_FAILED stays an error flag** after the data is entered by hand, so approving such an invoice needs "approve anyway" (recorded as `overriddenFlags: ["EXTRACTION_FAILED"]`). See Q1.
3. **Next to review** = the first `needs_review` invoice in To review's default order other than `after` (the head of the queue), as the task words it. See Q4.
4. **"Save & approve" checks again after saving**: if required fields are still missing it says which and doesn't approve; Approve is disabled with the reason in a tooltip only while the form is clean.
5. **Edits made by someone else** show up as 409 STALE on save; if the page receives a newer version of the invoice while it holds unsaved edits (a refetch, e.g. after a conflict), the STALE banner appears right away and the edits stay. Without unsaved edits the page simply shows the newer data.
6. **Event times use `clock_timestamp()`** (§2.2). The events endpoint also returns `vendor` (resolved from `data.vendorId`) so Activity can name it.
7. **The `paid` event records `overriddenFlags`** too: paying despite an error is worth an audit line.
8. **Bank flags move**: in `unpaid`/`paid` the BANK_* flags appear directly above Payment details instead of in the issues list.
9. **Toasts** move above the sticky action bar on pages that have one (they covered Approve).
10. **Processing:** the pane shows the status word and "Reading the PDF…"; the previous values stay in the header until the new reading arrives.
11. **Reject and Re-extract** stay available with unsaved edits; the dialogs say the edits will be discarded.
12. **Line items** are edited two rows per line (description, then kind, quantity, unit, unit price, amount). Rows left completely empty are dropped on save.
13. **The read-only view** says "No bank details on the invoice." instead of seven empty rows.
14. **Annotation layer off** in the viewer: links inside vendor PDFs aren't clickable (phishing surface); text can still be selected and copied.

## 5. How to verify (from a clean clone)

Prerequisites: Node 24+, pnpm 9+, Docker. No Anthropic key needed (the stub extractor is the default).

```sh
git clone <repo-url> camex && cd camex && git checkout t06-review-and-pay
cp .env.example .env              # set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ chars)
pnpm install --frozen-lockfile
docker compose up -d --wait       # Postgres :55432, MinIO :59000/:59001
pnpm db:migrate                   # applies the two T06 migrations
pnpm test                         # api: 29 files, 364 tests; web: 59 tests
pnpm lint && pnpm typecheck && pnpm build    # clean, no chunk-size warning
pnpm seed:demo                    # empty database: "8 vendors, 29 invoices: 5 to review, 6 to pay, 17 paid, 1 rejected"
pnpm dev                          # API :3180, web http://localhost:5180
```

Then, signed in:

1. Invoices → To review → **SkyChef SCT-5588**: change Amount due to 2,289.50 → "Extracted: 2,298.50 · Restore" appears → Save (or Ctrl/Cmd+S) → Activity: "… changed Amount due from 2,298.50 to 2,289.50".
2. **Kolkhi KAS-0193** → Approve → Create vendor (name prefilled) → tick "Trust these bank details…" → Approve → toast "Approved. Moved to To pay." → Undo → Approve again (no dialog now).
3. Mark paid with a reference → Paid tab → open it → Undo payment.
4. The **ASM SI-000218719 reminder** → More → Reject… (Duplicate preselected) → Reject → the unpaid original loses its duplicate flags → Reopen.
5. The unreadable **scan_0412.pdf** → fill vendor, invoice #, invoice date, terms in days, amount due, pay in → Save & approve → tick "approve anyway" → Approve.
6. Open one invoice in two browsers, save in one, then in the other → "Someone else changed this invoice…" with Reload; the second person's edit stays until they reload.
7. From the first To review invoice, Approve & next until the list says "All caught up." (Petrocas needs its due date: fill Terms in days.)

Screenshots: `.review/T06/` (not committed; §7).

**What I actually ran:** the gates of §6.1 in the working tree; the walkthrough, viewer checks and screenshots against the separate compose project `camex-invoices-check` (Postgres 56432, MinIO 60000, the API built from this branch on 3181 with the stub extractor and workers on, the production web build served by `vite preview` on 5181), reseeded before each run; then a clean clone of `c44ea42` (this commit without the report) on a fresh `camex-invoices-check` stack (§6.2), torn down with its volumes afterwards. The dev stack was not reset; `prisma migrate dev` applied the two (additive) T06 migrations to its database.

## 6. Test results

### 6.1 Working tree

```
$ pnpm test
apps/web test: ℹ tests 59 · ℹ pass 59 · ℹ fail 0          (33 before)
apps/api test:  Test Files  29 passed (29)
apps/api test:       Tests  364 passed (364)               (328 before)
$ pnpm lint        → eslint clean, "All matched files use Prettier code style!"
$ pnpm typecheck   → shared, api, web: Done
$ pnpm build       → shared, api, web: Done (no chunk-size warning)
```

The API agent saw the extraction-worker test fail once under full-suite load; it passed alone and in its two later full runs, and in both of my full runs (working tree and clean clone).

### 6.2 Clean clone of `c44ea42`

```
$ git log --oneline -1           → c44ea42 T06: review and pay
$ pnpm install --frozen-lockfile → exit 0
$ docker compose -p camex-invoices-check up -d --wait → exit 0
$ pnpm db:migrate                → "All migrations have been successfully applied."
$ pnpm test                      → web: ℹ pass 59 · ℹ fail 0; api: Test Files 29 passed (29), Tests 364 passed (364)
$ pnpm lint                      → exit 0, "All matched files use Prettier code style!"
$ pnpm typecheck                 → exit 0
$ pnpm build                     → exit 0 (shared, api, web: Done; no chunk-size warning)
$ pnpm seed:demo                 → 8 vendors, 29 invoices: 5 to review, 6 to pay, 17 paid, 1 rejected
$ pnpm seed:demo                 → refuses: "The database already has 29 invoice(s) and 8 vendor(s)…"
```

### 6.3 Browser walkthrough (headless Chromium 1440×900, Playwright, seed:demo data; script outside the repo)

```
PASS  1. edit amount due → Save → activity shows it — was 2298.50; "Extracted" hint shown: true
PASS  1. header amount follows
PASS  2. dialog asks for a vendor, name prefilled — Kolkhi Aviation Services LLC
PASS  2. BANK_FIRST_SEEN step: details in Mono, trust unchecked
PASS  2. approved with vendor created and bank details trusted — unpaid, vendor Kolkhi Aviation Services LLC, flags none
PASS  2. toast Undo reopens it — needs_review
PASS  2. approve again (no dialog: vendor linked, account trusted) — unpaid
PASS  2. events: approved, reopened, approved, bank_account_trusted, vendor_linked
PASS  3. mark paid with a reference → listed under Paid
PASS  3. header says Paid today · ref TRX-2291
PASS  3. the Paid tab shows it
PASS  3. Undo payment → To pay, paid fields cleared — unpaid null null
PASS  4. Duplicate is preselected
PASS  4. rejected as duplicate — rejected
PASS  4. the original loses its duplicate flags
PASS  4. read-only view (no inputs) when rejected
PASS  4. reopen → To review, rejection cleared
PASS  5. issues list says the PDF could not be read
PASS  5. error flags need "approve anyway"
PASS  5. entered by hand and approved — unpaid SCT-5601 due 2026-10-12 (terms) 1140 GEL
PASS  5. approval records the overridden flags — {"overriddenFlags":["EXTRACTION_FAILED"]}
PASS  6. second save → STALE message with Reload
PASS  6. the second person's edit is still on screen
PASS  6. only the first save is stored
PASS  6. Reload shows their change
PASS  7. Approve & next walks the queue to "All caught up" — walked SI-000218719 → SCT-5588 → PFSG-CAM-00000000510; 0 left
PASS  no page errors
27/27 passed
```

Viewer and keyboard (same stack):

```
PASS  viewer loads the PDF with credentials (canvas drawn) — Page 1 of 1
PASS  page navigation disabled on a 1-page PDF
PASS  zoom in makes the page larger — 98% → 123%, 600px → 749px
PASS  fit width goes back
PASS  rotate 90° swaps the page orientation — 600x776 → 600x463
PASS  download saves the PDF under its name — Invoice_3110713.pdf
PASS  open in a new tab loads the PDF (inline, with the session) — 200 application/pdf
PASS  Ctrl/Cmd+S saves
PASS  leaving asks first; Stay keeps the edit
PASS  an unrenderable PDF shows a message with Download
PASS  no page errors
11/11 passed
PASS  page navigation on a 2-page PDF — shown pages 1 → 2, next disabled on the last: true   (an uploaded 2-page PDF)
```

Headless Chromium has no PDF viewer, so "open in a new tab" is checked by the tab's request (200, `application/pdf`, inline, with the session cookie) rather than by what it displays.

### 6.4 New and changed tests

- `apps/api/test/workflow.e2e.test.ts` (26): every action from every status (allowed ones move and bump the version, the rest 409 INVALID_TRANSITION); STALE before the status is looked at, nothing written; 400 without a version, 404; approve (fields and event; MISSING_REQUIRED with the fields even with confirmErrors; VENDOR_REQUIRED; CONFIRM_REQUIRED and the overridden codes; trust in the same transaction with its own event; a failed approve trusts nothing; BANK_UNKNOWN needs confirm even with trustBankDetails); mark paid (today in Tbilisi at the latest, 400 after; fields set and cleared; error flags need confirm); reject (note for "other"; rejecting a duplicate clears the other copy's flag; reopen brings it back); reopen from To pay (approval cleared, DISPUTE_SOON back); PATCH (normalization; 400 per field; only changed fields written and recorded; bank details and line items recorded with values; due date `manual` / cleared re-derived; a new number re-evaluates the invoices of the old one); re-extract (overwrites edits and the due date source, keeps the vendor, bumps the version; a changed number re-evaluates the old number's invoices); events newest first with user and vendor names; next-to-review order without processing or `after`; `extraction=failed` on list, summary and CSV; link and trust check and bump the version.
- Updated: `vendors.e2e`, `evaluation.e2e`, `guard.e2e` (version on link/trust), `flags.test` and `invoices.e2e` (human dates, the new detail fields), `dashboard.e2e` (trend window ends at the month; currencies from that window), `seed-demo.e2e` (29 invoices).
- Web: `lib/activity.test.ts` (10: each event type, single/multi-field edits, bank and line-item summaries, no codes, times and years in Tbilisi), `lib/line-items.test.ts` (10: exact sums, tolerance, tax, closer difference, unreadable amounts), `pages/invoices/detail/form-model.test.ts` (6: unchanged form, normalized changes only, clearing, field paths of refused values, amounts by value, derived due dates), `lib/attention.test.ts` (the new link).

## 7. Visual QA: what I fixed after looking at the screenshots and tests

1. **Toasts covered Approve / Mark paid** (both bottom right): the walkthrough's second Approve click was intercepted. Toasts now sit above the action bar on pages that have one.
2. **Unedited amounts showed "Extracted: 2,298.50 · Restore"**: the database returns "2298.5", the extraction "2298.50". Amounts are now compared by value (also line items) and shown in the form with at least two decimals.
3. **The pdf.js worker would not have loaded in production**: it is emitted as `.mjs`, and nginx 1.30's `mime.types` (the web image) has no `.mjs`, so with `nosniff` the module worker would be refused. Vite now emits it as `.js`; checked through the real nginx image with the repo's `default.conf`: `Content-Type: application/javascript`.
4. **The page was 1,920 px tall in a 900 px split**: a visually hidden table header escaped the scroll pane (absolute, no positioned ancestor). The scroll areas are `relative` now.
5. **The line-item amounts were cut off** in the ~500 px pane (single-row table): two rows per line, with column widths from a `colgroup` (fixed tables take widths from the first row, which spans).
6. Smaller: "Notes" was labelled twice (section and field); the read-only view repeated "Notes"; empty bank details showed seven dashes; "Reading the PDF…" appeared three times while processing; activity values in Mono included their "Was/Now" words and were too tall; the email disclosure's chevron wrapped.

Screens in `.review/T06/` (77 files; `-1440-light`, `-1440-dark`, `-390-light`, `-390-dark` unless noted; phone shots are the full page with the action bar at its real place; `-full` = the whole right pane at 1440 light):
`01-needs-review` (+full), `02-unpaid` (+full), `03-paid` (+full), `04-rejected` (+full), `05-processing`, `06-extraction-failed` (+full), `07-document-tab` (390), `08-edited` (+full), `10-approve-vendor` (1440, 390 light), `11-approve-bank-first-seen` (1440, 390 light), `12-approve-bank-unknown` (1440), `13-approve-errors` (1440), `14-mark-paid` (1440, 390 light), `15-mark-paid-errors` (1440), `16-reject` (1440, 390 light), `16-reject-other` (1440, note required), `17-reextract` (1440), `18-link-vendor` (1440), `19-leave-unsaved` (1440), `20-stale` (1440), `21-activity` (1440, details shown), `25-approve-blocked-tooltip` (1440), `30-home`, `31-home-september` (1440), `32-invoices-all` (1440 light, 390 light), `33-couldnt-be-read` (1440 light).

## 8. Known issues / shortcuts

- **Date inputs follow the browser's locale** (9 / 22 / 2026 in en-US), as in T05b's filters; shown dates are "22 Sep 2026".
- **The slashed zero stays** (0b #2).
- **A failed re-extraction keeps the previous values** (possibly edited) next to EXTRACTION_FAILED; the extraction overwrites only on success. See Q3.
- **Seeded invoices have no approval/payment events** (seed:demo writes the fields, not the history), so their Activity starts at "Read the PDF"; seeded PDFs don't match their data (T05b).
- **The PDF viewer shows one page at a time** (navigation buttons), not a continuous scroll.
- **The extraction-worker e2e test** failed once under load for the API agent (§6.1); not seen since.
- **Playwright tooling** (walkthrough, viewer checks, screenshots) lives in my scratchpad, not the repo, as in T05/T05b.

## 9. Questions for the CTO

1. **EXTRACTION_FAILED after manual entry.** It stays an error, so a hand-entered invoice always needs "approve anyway" (recorded as overridden). Keep that extra confirmation, or clear the flag once the required fields are filled?
2. **Payment details' position.** They sit fourth, after the whole data list (as specified). For To pay invoices, should they move up under the header, where the payer starts?
3. **Failed re-extraction.** Keep the previous values (current behaviour) or empty the fields so the page matches "Extraction failed"?
4. **Approve & next** goes to the head of the To review queue (the most urgent invoice), not to the row after the current one. Is that the intended order?
5. **Date input format.** Force day/month/year (en-GB) in date fields instead of the browser's locale?

## 10. `git diff --stat main...HEAD`

```
 README.md                                          |  10 +-
 .../20261004184114_invoice_version/migration.sql   |   2 +
 .../migration.sql                                  |   2 +
 apps/api/prisma/schema.prisma                      |   7 +-
 apps/api/src/app.module.ts                         |   2 +
 apps/api/src/cli/seed-demo.ts                      |  49 +-
 apps/api/src/dashboard/dashboard.service.ts        |   7 +-
 apps/api/src/evaluation/flags.ts                   |  13 +-
 apps/api/src/evaluation/invoice-evaluator.ts       |  28 +-
 apps/api/src/extraction/extraction.handler.ts      |   8 +-
 apps/api/src/extraction/normalize.ts               | 163 +---
 apps/api/src/inbox/inbox.service.ts                |  23 +-
 apps/api/src/inbox/stored-attachments.ts           |  25 +
 apps/api/src/invoices/invoice-list.service.ts      |  13 +
 apps/api/src/invoices/invoice-query.ts             |   3 +
 apps/api/src/invoices/invoices.controller.ts       |  23 +-
 apps/api/src/invoices/invoices.service.ts          | 122 ++-
 apps/api/src/invoices/workflow/invoice-edit.ts     | 130 ++++
 apps/api/src/invoices/workflow/transitions.ts      |  70 ++
 apps/api/src/invoices/workflow/workflow-guard.ts   |  85 +++
 .../src/invoices/workflow/workflow.controller.ts   |  98 +++
 apps/api/src/invoices/workflow/workflow.module.ts  |  14 +
 apps/api/src/invoices/workflow/workflow.service.ts | 297 ++++++++
 apps/api/src/vendors/invoice-vendor.controller.ts  |   5 +-
 apps/api/src/vendors/invoice-vendor.service.ts     | 100 +--
 apps/api/src/vendors/trust-bank-details.ts         |  62 ++
 apps/api/test/dashboard.e2e.test.ts                |  58 +-
 apps/api/test/evaluation.e2e.test.ts               |   9 +-
 apps/api/test/flags.test.ts                        |  17 +-
 apps/api/test/guard.e2e.test.ts                    |   9 +
 apps/api/test/invoices.e2e.test.ts                 |  48 +-
 apps/api/test/seed-demo.e2e.test.ts                |  28 +-
 apps/api/test/vendors.e2e.test.ts                  |  77 +-
 apps/api/test/workflow.e2e.test.ts                 | 816 +++++++++++++++++++++
 apps/web/package.json                              |   2 +
 apps/web/src/components/app-layout.tsx             |  19 +-
 apps/web/src/components/wrapping-identifier.tsx    |  21 +
 apps/web/src/index.css                             |   8 +-
 apps/web/src/lib/activity.test.ts                  | 284 +++++++
 apps/web/src/lib/activity.ts                       | 302 ++++++++
 apps/web/src/lib/attention.test.ts                 |   1 +
 apps/web/src/lib/attention.ts                      |   3 +-
 apps/web/src/lib/format.ts                         |   7 +
 apps/web/src/lib/invoice-labels.ts                 |  87 ++-
 apps/web/src/lib/line-items.test.ts                | 105 +++
 apps/web/src/lib/line-items.ts                     | 115 +++
 apps/web/src/lib/use-element-width.ts              |  16 +
 apps/web/src/pages/home/home-page.tsx              |  35 +-
 apps/web/src/pages/home/month-ledger.tsx           |  14 +-
 apps/web/src/pages/home/trend-chart.tsx            |  28 +-
 apps/web/src/pages/inbox/invoice-link.tsx          |   4 +-
 apps/web/src/pages/invoices/detail/action-bar.tsx  | 171 +++++
 .../src/pages/invoices/detail/action-dialogs.tsx   | 565 ++++++++++++++
 apps/web/src/pages/invoices/detail/detail-query.ts | 138 ++++
 apps/web/src/pages/invoices/detail/field-focus.ts  |  18 +
 apps/web/src/pages/invoices/detail/form-fields.tsx | 334 +++++++++
 .../src/pages/invoices/detail/form-model.test.ts   | 124 ++++
 apps/web/src/pages/invoices/detail/form-model.ts   | 294 ++++++++
 .../pages/invoices/detail/invoice-detail-page.tsx  | 592 +++++++++++++++
 .../src/pages/invoices/detail/invoice-facts.tsx    | 198 +++++
 .../src/pages/invoices/detail/invoice-header.tsx   | 105 +++
 .../pages/invoices/detail/line-items-editor.tsx    | 267 +++++++
 apps/web/src/pages/invoices/detail/pdf-viewer.tsx  | 251 +++++++
 apps/web/src/pages/invoices/detail/review-form.tsx | 270 +++++++
 .../src/pages/invoices/detail/side-sections.tsx    | 325 ++++++++
 apps/web/src/pages/invoices/detail/state-line.ts   |  74 ++
 .../src/pages/invoices/detail/vendor-linker.tsx    | 156 ++++
 apps/web/src/pages/invoices/invoice-filters.tsx    |  16 +
 apps/web/src/pages/invoices/invoice-page.tsx       | 112 ---
 apps/web/src/pages/invoices/invoices-page.tsx      |  17 +-
 apps/web/src/pages/invoices/invoices-query.ts      |   9 -
 apps/web/src/pages/invoices/invoices-table.tsx     |   3 +-
 apps/web/src/pages/invoices/list-params.ts         |  10 +-
 apps/web/src/router.tsx                            |   4 +-
 apps/web/vite.config.ts                            |  23 +
 docs/SPEC.md                                       |  42 +-
 docs/reports/T06-review-and-pay.md                 | 348 +++++++++
 docs/tasks/T06-review-and-pay.md                   | 224 ++++++
 packages/shared/src/dashboard.ts                   |   4 +-
 packages/shared/src/dates.ts                       |  21 +
 packages/shared/src/index.ts                       |   2 +
 packages/shared/src/invoice-list.ts                |   5 +
 packages/shared/src/invoice-workflow.ts            | 332 +++++++++
 packages/shared/src/invoices.ts                    |  67 +-
 packages/shared/src/normalize.ts                   | 150 ++++
 packages/shared/src/vendors.ts                     |  16 +-
 pnpm-lock.yaml                                     | 204 ++++++
 87 files changed, 8470 insertions(+), 495 deletions(-)
```
