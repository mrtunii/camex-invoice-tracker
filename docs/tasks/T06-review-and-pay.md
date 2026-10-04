# T06 — Invoice detail: review, approve, pay

You are implementing task T06 of the Camex Invoice Tracker. Read CLAUDE.md, docs/SPEC.md (§5–§10), docs/reports/T05b-ui-overhaul.md and this file before writing code.

This is the screen where finance does its actual work:
- the original PDF on the left, the extracted data on the right;
- fix what's wrong, approve, later mark as paid;
- every action recorded.

Same design system and rules as T05b (dark cockpit, no badges, plain words).

## 0. Git: merge the accepted T05b first

```sh
git checkout main
git pull --ff-only
git merge --ff-only t05b-ui-overhaul
git push origin main
```

- Any failure → stop and ask. Never force-push, rebase, reset `main` or create merge commits.
- Only `docs/tasks/T06-review-and-pay.md` (CTO-provided) may be untracked.
- Branch `t06-review-and-pay`; commit this file with the task; one commit "T06: review and pay". Don't merge or push it.
- Report the git commands and their output.

## 0b. T05b follow-ups (CTO review of the screenshots + answers)

1. **Mobile chart bug:** at 390 px the chart renders tiny inside a tall empty panel (`02-home-390-*`). It must fill the panel width at a sensible height.
2. **Slashed zeros:** amounts and dates show slashed zeros ("2Ø26", "14,ØØØ.83"). Check whether Atkinson Hyperlegible Next has an OpenType alternate with a plain zero.
   - If it does: plain zero for all sans text, slashed zero kept in the Mono identifiers.
   - If not: keep it, and say so in the report.
3. **Never truncate invoice numbers** in lists (`PFSG-CAM-00…` loses the distinctive end). Give the column the width it needs, or wrap. Vendor names may wrap.
4. **Month ledger on desktop** leaves about 40% of its panel empty. Lay out the ledger and the chart so nothing looks unfinished at 1440 px; your call. On mobile, keep amount and count on one line (count smaller and muted), or drop counts below 640 px.
5. **Caution token:** use `#A15F00` in light mode.
6. **Chart:** 12 months ending at the picked month, not always at the current month.
7. **Add an `extraction=failed` filter** to the list API and URL. The status sentence's "couldn't be read" link uses it.
8. **Flag messages:** human dates ("Dispute window ends 6 Oct 2026"), not ISO. Messages refresh on each evaluation; that's enough, no backfill.
9. **Bundle size:** accepted as is. **Passed dispute windows:** stay out of the sentence.

## 1. Workflow (SPEC §6), one state machine module

`apps/api/src/invoices/workflow/`: the transition table as data, one service that applies it. Every action:
- runs in one transaction with a row lock;
- checks the status and `version` (below);
- writes its event with the user;
- re-runs `evaluate`.

`evaluateWithRelated` runs after commit.

**Optimistic concurrency**
- New column `invoices.version int not null default 0`. Every human write (edit or transition) increments it; the evaluator and the extraction worker don't.
- Each write request carries `version`; a mismatch → 409 `{ code: "STALE", message: "Someone else changed this invoice. Reload to see their changes." }`.
- Re-extract also increments it, so a form open from before the re-extract can't be saved over the fresh data.

| Action | From → to | Rules |
|---|---|---|
| **Edit** `PATCH /api/invoices/:id` | needs_review | See §2. |
| **Approve** `POST …/approve` | needs_review → unpaid | 1. Re-evaluate first, inside the transaction. 2. Required fields (SPEC §6) present, else 409 `MISSING_REQUIRED` with the fields; this can't be overridden. 3. A vendor must be linked, else 409 `VENDOR_REQUIRED`. 4. Any error flag needs `confirmErrors: true`, else 409 `CONFIRM_REQUIRED` with the flags (code, message). 5. Optional `trustBankDetails: true` adds the bank account to the vendor in the same transaction (T04 rules), with its own `bank_account_trusted` event. Sets `approved_at` / `approved_by_id`. Event `approved { overriddenFlags: [codes] }`. |
| **Reject** `POST …/reject` | needs_review → rejected | `{ reason: duplicate \| not_invoice \| disputed \| other, note }`; note required for `other`. Event `rejected { reason, note }`. |
| **Re-extract** `POST …/reextract` | needs_review → processing | Sets `extraction_status = pending` and enqueues the job. The extraction overwrites every extracted field, including edits, and resets `due_date_source`. It keeps `vendor_id` (a deliberate link). Event `reextracted`. |
| **Mark paid** `POST …/mark-paid` | unpaid → paid | `{ paidAt (YYYY-MM-DD, ≤ today in Tbilisi), paymentReference?, paymentNote? }`. Re-evaluate first: any error flag (e.g. BANK_UNKNOWN after a trusted account was removed) needs `confirmErrors: true`, otherwise 409 `CONFIRM_REQUIRED`. Paying is the moment fraud costs money. Event `paid { paidAt, reference }`. |
| **Undo payment** `POST …/undo-payment` | paid → unpaid | Clears the paid fields. Event `payment_undone { previousPaidAt }`. |
| **Reopen** `POST …/reopen` | unpaid → needs_review; rejected → needs_review | Clears approval or rejection fields; the history stays in events. Event `reopened { from }`. |

Any action from a wrong status → 409 `INVALID_TRANSITION`.

**Other endpoints**
- **`GET /api/invoices/:id/events`**: newest first: `{ id, type, at, user: { id, name } | null, data }`.
- **`GET /api/invoices/next-to-review?after=<id>`**: the next id in the To review default order, excluding `processing` and `after`. Otherwise `{ id: null }`. Used by "Approve & next".
- **`GET /api/invoices/:id`** adds:
  - `version`;
  - approval, payment and rejection fields with user names;
  - `extracted`: `normalizeExtraction(extraction_raw)`, the original reading, so the UI can mark edited fields. Null if the extraction failed.
  - the source email summary (`from`, `subject`, `receivedAt`, ignored attachments; the body via the existing inbox endpoint).

## 2. Editing (`PATCH /api/invoices/:id`)

- **Body:** `version` plus any subset of the extracted fields in the domain shape. `lineItems` and `bankDetails` replace the whole value. Zod validation in `packages/shared`.
- **Normalization:** the same rules as extraction (the T03 normalizers, adapted to domain input): registration hyphen, flight shorthand, IBAN/SWIFT compaction, codes uppercase, real dates, decimals within `numeric(18,4)`.
- **Due date:**
  - setting `dueDate` sets `due_date_source = manual`;
  - clearing it sets the source to null, so it is derived again.
- **Event `edited`:** data is `{ field: { from, to } }` for the changed fields only. Bank detail changes are stored with their values: an IBAN edit is exactly what an audit must show. Never log them.
- **After commit:** re-evaluate the invoice and its related invoices, including those related through the **old** invoice number and old vendor key (the T04 known issue).

## 3. Detail page `/invoices/:id`

**Layout**
- At ≥ 1024 px: a resizable split, PDF left (default 55%), data right. Use `react-resizable-panels`; persist the ratio in localStorage.
- Below 1024 px: two tabs, "Document" and "Details".
- A back link keeps the list's filters: history back if the user came from the list, else `/invoices`.

**PDF viewer** (`react-pdf` / pdf.js)
- **Loading:** from the API with `withCredentials`; pdf.js worker bundled by Vite; `isEvalSupported: false`.
- **Controls:** page navigation, zoom, fit width (default), rotate 90° (scans), download, open in a new tab.
- **Failure:** if the PDF can't be rendered, a plain message with the download link.

**Right pane, top to bottom**
1. **Header:**
   - vendor (linked vendor name, else the extracted name and a quiet "Link vendor" action);
   - invoice number in Mono; status word with dot;
   - amount due in 30 px tabular figures with its currency;
   - one line of state in words: "Dispute window ends Tue 6 Oct", "Approved by Nino on 3 Oct · Due Fri 9 Oct", "Paid 4 Oct · ref TRX-2291".
2. **Issues**, only if there are error or warning flags: each message on its own line with its colour; clicking one focuses that field. Info flags go in a quiet "For your information" line underneath. Codes never appear.
3. **Form**, in review order:
   - Summary: vendor, invoice #, document type, category, description;
   - Amounts: currency, subtotal, tax, total, amount due, pay in;
   - Dates & terms: invoice date, service date, due date (derived dates say how they were derived), terms, dispute window;
   - Bank details;
   - Line items: editable rows with add and remove; the line total and the difference from the total shown live under the table;
   - Operation: airport, aircraft, flights;
   - Notes.

   Two details:
   - **Edited fields** show the original under the field in muted text: "Extracted: 6,461.29 · Restore". No badge.
   - **Outside `needs_review`** the form renders as read-only text (a definition list), not disabled inputs.
4. **Payment details** (`unpaid` and `paid`): beneficiary, bank, IBAN or account, SWIFT, routing, amount, and a suggested payment reference (the invoice number). Each has a copy button. Bank warnings show directly above this block.
5. **Source email:** from, subject, received; body collapsed; ignored attachments.
6. **Activity:** the events as plain sentences, newest first. Examples: "Nino approved · 3 Oct, 14:02", "Otto changed Amount due from 6,461.29 to 6,416.29", "Matched to AEG Fuels by name", "Payment undone". Diffs of line items and bank details are summarised ("changed bank details: IBAN"), with "Show" to expand values.

**Action bar**, sticky at the bottom of the right pane:

| Status | Primary | Secondary | In the "More" menu |
|---|---|---|---|
| needs_review | **Approve**, or "Save & approve" when the form has unsaved changes | Save (only when dirty), Approve & next | Reject, Re-extract |
| unpaid | **Mark paid** | | Reopen |
| paid | | Undo payment | |
| rejected | | Reopen | |

- **Ctrl/Cmd+S** saves.
- **Leaving with unsaved changes** asks first.
- **A 409 STALE** shows the message and a Reload button; the user's edits are not discarded silently.

**Approve dialog**: opens only when something needs a decision; otherwise Approve acts immediately. It shows, in order, only the steps that apply:
1. **No vendor:** link an existing one (searchable ComboBox), or create one with the extracted name prefilled.
2. **BANK_FIRST_SEEN:**
   - show the bank details in Mono;
   - a checkbox "Trust these bank details for <vendor>", unchecked by default, with the hint "Only if you have confirmed them with the vendor".
3. **BANK_UNKNOWN:** the SPEC text "Bank details differ from the ones on file. Verify by phone with the vendor before paying." in red.
4. **Other error flags:** their messages, and a checkbox "I've checked these and want to approve anyway". The BANK_UNKNOWN warning above also requires this checkbox.

Confirm button: "Approve". **Missing required fields** don't open the dialog: the issues list already points at them, and Approve stays disabled with the reason in a tooltip.

**Feedback after actions**
- Approve: toast "Approved. Moved to To pay." with **Undo** (reopen).
- Mark paid: toast with **Undo** (undo payment).
- Approve & next: goes to the next invoice to review, or to the To review list with "All caught up" when none are left.

**Mark paid dialog:**
- paid date (defaults to today), reference, note;
- the amount and beneficiary shown read-only, for a last look;
- error flags shown with the confirm checkbox, as in approve.

**Reject dialog:**
- reason as a radio group: Duplicate, Not an invoice, Disputed with vendor, Other;
- "Duplicate" is preselected when a duplicate flag is present;
- a note field, required for Other.

**Re-extract:** an AlertDialog: "Read the PDF again? This replaces every field with a fresh reading. Your edits will be lost."

**Processing state:** the right pane shows "Reading the PDF…" and polls; the PDF is already viewable.

**Extraction failed:** the issues list says so; the form is empty and editable for manual entry; Re-extract stays available.

## 4. Dependencies

Add `react-pdf` (check the current version's React 19 support and its pdf.js worker setup for Vite) and `react-resizable-panels`. Justify both in the report. Nothing else.

## 5. SPEC edits

- §5: `version`.
- §6: the transition table above (vendor required to approve; error confirmation on approve and on mark paid; version conflicts; re-extract keeps the vendor link).
- §10: the detail page as built, concisely.

## 6. Tests

**API**
- Every allowed and disallowed transition (matrix test); STALE on a wrong version.
- Approve:
  - each 409 (missing required even with `confirmErrors`, vendor required, confirm required);
  - confirm records the overridden codes;
  - trust in the same transaction;
  - BANK_UNKNOWN requires confirm.
- Mark paid: future date → 400; error flags need confirm.
- Reject: a note is required for `other`. Reopen clears fields; undo payment clears paid fields.
- PATCH:
  - normalization;
  - an `edited` diff containing only the changed fields;
  - `dueDate` → `manual`, and clearing it re-derives;
  - changing the invoice number re-evaluates invoices related through the old number (a duplicate flag clears on the other invoice).
- Re-extract overwrites edited fields, keeps the vendor link and bumps `version`.
- `next-to-review` order; the events endpoint with user names.
- The 0b items: `extraction=failed` filter, human dates in flag messages, chart window ending at the picked month.

**Web:** unit tests for the activity sentence builder and the line-items total/difference helper.

**Browser walkthrough** (Playwright, outside the repo, against `seed:demo` data). All of these must pass:
1. open a To review invoice → edit the amount due → Save → the activity shows the change;
2. Approve with no vendor → create the vendor in the dialog → trust the bank details → approved → toast Undo works → approve again;
3. Mark paid with a reference → it appears under Paid → Undo payment;
4. reject a duplicate; reopen it;
5. an extraction-failed invoice: enter the fields by hand → approve;
6. two browser contexts editing the same invoice → the second save gets the STALE message;
7. Approve & next walks through the queue until "All caught up".

**Visual QA:** screenshots to `.review/T06/`:
- each status (needs_review, unpaid, paid, rejected, processing, extraction failed);
- each dialog variant;
- the edited-field state;
- 1440 px (split) and 390 px (tabs), light and dark.

Review your own screenshots and fix what looks wrong before the report.

## Out of scope

Bounding boxes and highlights on the PDF, partial payments, multiple approvers, notifications, bulk actions.

## Done when

The full loop works in the browser: received → reviewed and corrected → approved (with vendor and bank trust) → paid. Every step is visible in Activity, and all seven walkthrough paths pass.

## Report

`docs/reports/T06-review-and-pay.md` with the sections from CLAUDE.md, the §0 git log, the 0b outcomes (including the zero glyph finding), dependency versions, the walkthrough results, and `git diff --stat main...HEAD`. Don't claim anything works unless you ran it.
