# T05b — UI overhaul on HeroUI v3 + Home

Branch `t05b-ui-overhaul`, one commit "T05b: UI overhaul + home". Not merged, not pushed.

## 0. Git (§0)

`main` was at `056116d` (= `origin/main`); T05 fast-forwarded it to `a7fe5b8`. The only untracked file was `docs/tasks/T05b-ui-overhaul.md`; it is committed with T05b.

| Command                                 | Output                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `git checkout main`                     | `Switched to branch 'main'` · `Your branch is up to date with 'origin/main'.`                          |
| `git pull --ff-only`                    | `Already up to date.`                                                                                  |
| `git merge --ff-only t05-invoices-list` | `Updating 056116d..a7fe5b8` · `Fast-forward` · `38 files changed, 3963 insertions(+), 68 deletions(-)` |
| `git push origin main`                  | `To github.com:mrtunii/camex-invoice-tracker.git` · `056116d..a7fe5b8  main -> main`                   |
| `git checkout -b t05b-ui-overhaul`      | `Switched to a new branch 't05b-ui-overhaul'`                                                          |

## 1. Summary

- **Every screen is on HeroUI v3 (`@heroui/react` / `@heroui/styles` 3.2.6, the current release)** with the "dark cockpit" tokens and rules of §2: login and set password, Home, Invoices, the interim invoice page, Inbox, Vendors, Team, the upload / change-password / add-person / reset-password dialogs, toasts and not-found. shadcn/ui, `radix-ui`, `class-variance-authority`, `shadcn`, `sonner`, `tw-animate-css`, `cn` and `components.json` are gone; `grep -r "components/ui\|radix-ui\|sonner" apps/web/src` returns nothing.
- **Home (`/`)** shows the status sentence, the To review and To pay panels, the month ledger with a month picker, the 12-month chart (Recharts 3.10.1) with a currency select and a hidden table, and By category / Top vendors, all from `GET /api/dashboard`.
- **API:** the dashboard endpoint (every sum in SQL numeric, Tbilisi business dates); due soon = 7 days everywhere; list items and Inbox invoices carry flag messages (for the one-icon tooltip); the list returns per-currency totals for the totals line. `month=0000-01` and `invoiceDateFrom=0000-01-01` now get 400 instead of a 500 (§3).
- **Dev-only `pnpm seed:demo`**: the three fixtures plus 25 generated invoices over 12 months, 8 vendors, USD and GEL; refuses `NODE_ENV=production` and non-empty databases.
- **Tests:** API 328/328 in 28 files (309 before; +15 dashboard, +2 seed, +1 list, +1 inbox, plus new cases inside existing tests); web 33/33 (27 unit tests for the status sentence, panel reasons and relative dates; 6 existing config tests). Lint, typecheck and build are clean, in the working tree and in a clean clone (§5).
- **Visual QA:** 98 screenshots in `.review/T05b/` (22 screens at 1440 and 390 px, light and dark; empty Home; keyboard focus). I reviewed them and fixed 18 problems before writing this (§7), including a crash when switching between list tabs that only an interaction test could find. Keyboard: every tab stop on 7 pages has a visible focus indicator in both themes. `prefers-reduced-motion` is honoured. An 18-step interaction test in a browser passes (§6).
- **Bundle:** `/login` downloads 284 kB gzip, Home 356 kB (+98 kB when the chart loads), `/invoices` 421 kB. Before, every route downloaded the whole app, 237 kB. HeroUI v3 (React Aria) is heavier than Radix; the split keeps the chart, tables and date pickers off `/login` (§2.3, Q1).
- **Built in two parallel tracks:** the API half (dashboard service and e2e tests, list/inbox changes, seed script) was written by a sub-agent from a shared contract I wrote first in `packages/shared/src/dashboard.ts`; I reviewed its code and re-ran its suites, and the full suite (§6).

## 2. What was built

### 2.1 Design system (`apps/web/src/index.css`)

- **Tokens:** the CTO's hex values converted to OKLCH and mapped onto HeroUI's variables, light and dark (`:root, .light, [data-theme=light]` / `.dark, [data-theme=dark]`): canvas → `--background`, surface → `--surface`, ink → `--foreground`, muted → `--muted`, line → `--border`/`--separator`, primary → `--accent` (and `--focus`, `--link`, field focus border), warning → `--danger`, caution → `--warning`, ok → `--success`. Tailwind aliases `text-caution`, `bg-ok`, `border-line`, `text-primary` read the same variables.
- **Shadows:** `--surface-shadow` and `--field-shadow` are `none`; only overlays keep one. Panels are a surface with a 1 px line (`Panel`, `TablePanel`).
- **Radius:** 6 px controls (`--field-radius`, `.button`, `.toggle-button`, `.tag`); 10 px panels, tables, dialogs, menus and popovers (HeroUI rounds all of those through `--radius-3xl`, which now points at the panel radius).
- **Type:** Atkinson Hyperlegible Next everywhere, Mono for invoice numbers, IBANs, account numbers, SWIFT, temporary passwords; `.tabular` on every amount and date. Scale 13 / 14 / 16 / 20 / 30 px expressed as Tailwind's `xs` (redefined to 13 px) / `sm` / `base` / `xl` / `3xl` — see decision 9.
- **Theme:** Light / Dark / System in the user menu, stored by HeroUI's `useTheme` in `localStorage` (`heroui-theme`). One controller (`ThemeProvider`) at the root; a 10-line script in `index.html` applies the stored theme before the first paint so dark users get no light flash.
- **Reduced motion:** a global `prefers-reduced-motion: reduce` rule collapses transitions and animations; HeroUI also has its own `motion-reduce` rules.

### 2.2 Components and pages (`apps/web/src`)

- **Shell:** `AppLayout` — the 224 px sidebar (Home, Invoices, Inbox, Vendors; Team and the user menu at the bottom), icons with tooltips below 1024 px, a HeroUI Drawer behind a menu button below 640 px. Content left-aligned, at most 1280 px. `RootLayout` connects React Aria links to react-router (`RouterProvider`) and holds the Suspense fallback and a route error page (for a page chunk replaced by a new deploy).
- **Shared:** `FormTextField` (react-hook-form `Controller` → HeroUI `TextField`/`Input`/`FieldError`, `validationBehavior="aria"`), `TagInput` (HeroUI `TagGroup` + an input; the one place with removable chips), `FlagIcon` (one icon: red with any error, amber with any warning, nothing otherwise; the tooltip lists the messages, errors first), `StatusWord` (6 px dot + word; green only for Paid; spinner + "Reading…" while processing), `ToneText`, `Panel`, `TablePanel`, `PageHeader`, `AuthScreen`, `AppToasts` (HeroUI Toast).
- **Home:** `pages/home/` — `StatusSentence`, `AttentionPanel`, `MonthLedger` (a HeroUI table, one column per currency, "amount (count)"), `TrendChart` (lazy; grouped bars coloured with `currentColor` so they follow the theme, no gridlines, faint baseline, abbreviated axis, exact-amount tooltip, "This month" label under the current month, an `sr-only` table), `RankedList`. Month and currency are in the URL (`/?month=2026-09&currency=GEL`).
- **Pure logic with tests:** `lib/attention.ts` (status sentence, panel reasons, the sentence's links) and `lib/format.ts` (relative days, due and dispute phrases, months, axis abbreviations; amounts now "15,617.79 USD").
- **Invoices:** HeroUI `Tabs` (counts as plain muted text), filters on one row at ≥ 1024 px (SearchField, vendor and currency ComboBoxes, category Select, DateRangePicker, "Errors only" Switch; vendor/category/currency/date move into a "Filters" popover below 1024 px), the To pay segmented control (ToggleButtonGroup: All · Overdue · This week), the totals line with Export CSV, HeroUI `Table` with sortable headers and the badge rules, HeroUI `Pagination`.
- **Inbox:** same structure; invoices are plain links (file name, status word in muted text, flag icon); the email opens in a Drawer.
- **Vendors:** table, Drawer to edit (tag inputs for aliases and domains), trusted accounts with identifiers in mono, Remove behind an AlertDialog.
- **Team** (`/team`; `/users` redirects): table with "Active"/"Deactivated" and "Temporary password" as plain text, Modals for add person and reset password, AlertDialog to deactivate.
- **Code splitting:** every page is `React.lazy` (router.tsx), and so are the app shell, the set-password screen and the chart. Toasts are mounted by the shell, not the entry.

### 2.3 Bundle sizes

Measured from Vite's manifest: a route's JS + CSS = the entry's static graph plus each page chunk's graph, gzip level 9; fonts excluded (unchanged). "Before" is `main` (T05, `a7fe5b8`), built the same way.

| Route               | Before (T05)           | After (T05b)                      |
| ------------------- | ---------------------- | --------------------------------- |
| any route           | 812.5 kB (237.4 kB gz) | —                                 |
| entry (index.html)  | same single bundle     | 978.6 kB (210.1 kB gz)            |
| `/login`            | 812.5 kB (237.4 kB gz) | 1214.1 kB (284.1 kB gz)           |
| `/` Home            | 812.5 kB (237.4 kB gz) | 1434.9 kB (356.1 kB gz)           |
| Home + chart (lazy) | —                      | 1777.1 kB (454.4 kB gz)           |
| `/invoices`         | 812.5 kB (237.4 kB gz) | 1647.5 kB (421.3 kB gz)           |
| `/inbox`            | 812.5 kB (237.4 kB gz) | 1417.5 kB (350.7 kB gz)           |
| `/vendors`          | 812.5 kB (237.4 kB gz) | 1441.8 kB (358.8 kB gz)           |
| `/team`             | 812.5 kB (237.4 kB gz) | 1407.3 kB (345.4 kB gz)           |
| all chunks          | 2 files                | 2139.8 kB (625.1 kB gz), 54 files |

Where the weight is:

- **CSS: 453.9 kB (43.5 kB gz)**, was 73.3 kB (12.8 kB gz): `@import "@heroui/styles"` brings every component's styles (the task's import).
- **React Aria:** FocusScope, collections and selection, overlays. HeroUI's `Input` imports `ComboBoxContext`, so every page with a text field (including `/login`) loads the ComboBox / Popover / Menu code (~32 kB gz). That is inside `@heroui/react`.
- **Recharts: ~98 kB gz**, only when Home's chart renders.
- The old single chunk is gone (no Vite size warning). What I trimmed: the toast code out of the entry (`/login` 295.0 → 284.1 kB gz, entry 223.7 → 210.1 kB gz). Options to go further are in Q1.

### 2.4 API (`apps/api`, `packages/shared`)

- **Contract first** (`packages/shared/src/dashboard.ts`): `dashboardQuerySchema` (strict; `month` YYYY-MM, `currency` any case) and `dashboardSchema` with every field documented.
- **`GET /api/dashboard`** (`apps/api/src/dashboard/`), session required:
  - `attention` reuses the list's status conditions, default sorts and `due` filters, so Home's counts, rows and links agree with the list.
  - `ledger`: invoiced / paid (by `paid_at`) / to pay / to review, per currency, `trim_scale(sum(amount_due))::text`.
  - `trend`: 12 months ending with the current month, empty months `"0"`/0.
  - `currency`: the request's, else the most invoiced (by count) in the period; `currencies` for the select.
  - `categories` and `topVendors`: top 5 of the month's invoiced in that currency.
- **List and Inbox:** `DUE_SOON_DAYS = 7` drives `dueState`, `due=soon` and `dueNext7Count`; `DISPUTE_SOON_DAYS = 3` names the dispute window (flags.ts uses it, behaviour unchanged). Flags in list items and Inbox invoices include `message`. The list response adds `totals` (per currency over every matching row, not the page) and `withoutAmount`.
- **`pnpm seed:demo`** (`apps/api/src/cli/seed-demo.ts`): goes through the production steps (wire output → normalize → columns → the real `InvoiceEvaluator`), uploads a PDF per invoice, writes everything in one transaction (never a committed `processing` row, so the recovery sweep can't call the paid extractor). Dates are relative to today in Tbilisi.

### 2.5 Docs

SPEC §6 (due soon = 7 days), §10 rewritten (principles, Home, screens), §13 (T05b row). README ("Home and the invoices list", `seed:demo`), CLAUDE.md (HeroUI in the layout line, `seed:demo`), `.gitignore` (`.review/`).

## 3. Deviations (with reasons)

1. **Two additive API fields beyond §5.** The list response gained `totals` and `withoutAmount` (§4's totals line needs per-tab sums; the API only had unpaid totals), and list/Inbox flags gained `message` (§2's tooltip lists messages; the API only sent codes). Existing fields and their meaning are unchanged.
2. **Year 0000 refused** in `yearMonthSchema` and `validCalendarDateSchema`. Postgres has no year 0, so these passed validation and failed with 500. The second one is a T05 parameter; same one-line fix, with tests.
3. **`/users` is now `/team`** (the nav label in §2), with a redirect.
4. **Tooltips on truncated table text use the native `title`.** HeroUI's `Tooltip.Trigger` is a focusable `role="button"`; on every truncated cell it would add hundreds of tab stops. Meaningful tooltips (flag icon, collapsed sidebar) use HeroUI's.
5. **The seed builds its services without a Nest application context.** The sub-agent reported that under `tsx` (esbuild, no decorator metadata) Nest cannot resolve class-typed constructor parameters ("can't resolve dependencies of the InvoiceEvaluator (?, ENV, CLOCK)"); I did not reproduce that myself. It constructs `PrismaService`, `StorageService` and `InvoiceEvaluator` directly. `trustedAccountFrom` accepts a null user for accounts seeded on a database without users.

## 4. Decisions not in the spec

1. **To review includes `processing`**, on Home and in the sentence, so the number equals the To review tab its link opens; such rows say "Reading…".
2. **The dispute clause counts deadlines from today to today + 3** (DISPUTE_SOON's window), names the earliest one ("A dispute window closes tomorrow." / "2 dispute windows close soon, the first tomorrow."). Passed deadlines are not in the sentence (nothing left to act on); rows still show "Dispute window closed 3 days ago" in red.
3. **Sentence wording:** "1 invoice couldn't be read." for extraction failures; its link is `/invoices?hasErrors=true` (no "extraction failed" filter exists; its error flag is what Errors only finds). Numbers are coloured by meaning: overdue and unreadable red, dispute and due-this-week amber, to review in the link colour.
4. **Panel reason order (To review):** a dispute window closed or closing within 3 days → extraction failed → first error flag message → a later dispute deadline → "Nothing flagged". To pay: "Overdue 18 days" / "Due Fri 9 Oct" / "Due 16 Oct 2026" / "No due date".
5. **The chart is the last 12 months up to the current month** (its title), independent of the ledger's month picker; categories and vendors follow the picked month. Bar heights use `Number()` of the decimal strings; every amount people read (tooltip, hidden table, lists) is the exact string.
6. **"Close" dates** are within 6 days either way ("Fri 9 Oct"), plus Today / Tomorrow / Yesterday. Due dates are coloured only while the invoice is `unpaid`; dispute deadlines only while `needs_review`.
7. **Tabs keep filters but drop "when due"** unless the new tab is To pay (otherwise Paid would show nothing under `due=overdue`). The segmented control also shows if a hand-made URL sets `due` on another tab, so it can be cleared.
8. **Date range filter** is a HeroUI DateRangePicker (both ends). A URL with only one end still filters, and Clear filters removes it, but the picker shows it empty.
9. **Type scale on Tailwind's names.** Class merging (tailwind-merge, also inside HeroUI's own components) only recognises `xs`…`3xl` as font sizes; custom names like `text-meta` were read as colours and silently removed `text-danger` from the same element. 14/16/20/30 px are Tailwind's `sm`/`base`/`xl`/`3xl`; `xs` is redefined to 13 px, so HeroUI's small text also follows the scale (12 px isn't in it).
10. **Received column** shows the relative day and the time on two lines; the "derived due date" hint of T05 is gone from the list (it is information-level, which lists don't show).
11. **Empty panels show no count**; "View all" only when there are rows.
12. **Totals line:** "6 invoices · 7,222.25 GEL · 42,891.01 USD", plus "· 1 without amount" when some rows have none. Export CSV sits on that line as a quiet button, so the header keeps one primary action (Upload PDFs).
13. **Seed refuses any database with invoices or vendors** (vendor-name uniqueness is enforced by the service, so seeding next to existing vendors could duplicate them). It uses the oldest active user as approver/payer, or none.
14. **`react-is@19.3.0`** is a direct dependency: Recharts 3 needs `react-is` matching React, and the auto-installed peer was 16.13.1. **`@internationalized/date`** is direct because the date-range filter parses `YYYY-MM-DD` (it is HeroUI's peer, same version).

## 5. How to verify (from a clean clone)

Prerequisites: Node 24+, pnpm 9+, Docker. No Anthropic key needed (the stub extractor is the default).

```sh
git clone <repo-url> camex && cd camex && git checkout t05b-ui-overhaul
cp .env.example .env              # set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ chars)
pnpm install --frozen-lockfile
docker compose up -d --wait       # Postgres :55432, MinIO :59000/:59001
pnpm db:migrate
pnpm test                         # api: 28 files, 328 tests; web: 33 tests
pnpm lint && pnpm typecheck && pnpm build    # clean, no Vite chunk-size warning
pnpm seed:demo                    # on an empty database: "8 vendors, 28 invoices: 4 to review, 6 to pay, 17 paid, 1 rejected"
pnpm dev                          # API :3180, web http://localhost:5180
```

1. Sign in as the bootstrap admin and set a password. Home reads, for 4 Oct 2026: "4 invoices to review. A dispute window closes on Tue 6 Oct. 3 payments are overdue. 1 invoice couldn't be read." Each number opens the matching list.
2. To review and To pay panels: up to 5 rows, red/amber reason lines; View all opens the tab. Month ledger: October with GEL and USD columns; ‹ goes to September (the URL gets `?month=2026-09`), › is disabled on the current month. Chart: USD by default; switch to GEL.
3. `/invoices`: tabs with plain counts; no pills anywhere; one flag icon per row with the messages on hover; To pay → All · Overdue · This week; the totals line follows tab and filters.
4. User menu → Theme: Light / Dark / System; reload keeps the choice.
5. Narrow the window: icons-only sidebar below 1024 px, menu button + drawer below 640 px; tables scroll inside their panel, the page never scrolls sideways.
6. Run `pnpm seed:demo` again: it refuses (database not empty). `NODE_ENV=production pnpm seed:demo` refuses too.

Screenshots: `.review/T05b/` (not committed; see §7).

**What I actually ran:** the working-tree checks in §6; the screenshots and keyboard checks against the separate compose project `camex-invoices-check` (Postgres 56432, MinIO 60000, API 3181 built from this branch with `EXTRACTOR_PROVIDER=stub`, the production web build served by `vite preview` on 5181 with a generated `config.js` carrying an inbox address), seeded with `pnpm seed:demo`; then a clean clone of `183b9b4` (this commit without the report) on a fresh `camex-invoices-check` stack — results in §6. The interaction test ran first against the clone's own stack, then again after the last fixes against this branch's build on a fresh, seeded check stack. The dev stack and its database were not touched (its newest invoice predates this session).

## 6. Test results

Working tree:

```
$ pnpm test
apps/web test: ℹ tests 33 · ℹ pass 33 · ℹ fail 0
apps/api test:  Test Files  28 passed (28)
apps/api test:       Tests  328 passed (328)      (309 before)
$ pnpm lint        → eslint clean, "All matched files use Prettier code style!"
$ pnpm typecheck   → shared, api, web: Done
$ pnpm build       → shared, api, web: Done (no chunk-size warning)
```

Clean clone of `183b9b4` (`git clone --branch t05b-ui-overhaul`, `.env` from `.env.example` with the check ports and a bootstrap admin, fresh `camex-invoices-check` volumes):

```
$ git log --oneline -1          → 183b9b4 T05b: UI overhaul + home
$ pnpm install --frozen-lockfile → exit 0
$ docker compose -p camex-invoices-check up -d --wait → exit 0
$ pnpm db:migrate               → exit 0
$ pnpm test                     → web: ℹ pass 33 · ℹ fail 0; api: Test Files 28 passed (28), Tests 328 passed (328)
$ pnpm lint                     → exit 0, "All matched files use Prettier code style!"
$ pnpm typecheck                → shared, api, web: Done
$ pnpm build                    → shared, api, web: Done (no chunk-size warning)
$ pnpm seed:demo                → Seeded database "camex" and bucket "camex-invoices" for 2026-10-04 (Asia/Tbilisi):
                                    8 vendors, 28 invoices: 4 to review, 6 to pay, 17 paid, 1 rejected
$ pnpm seed:demo                → exit 1: The database already has 28 invoice(s) and 8 vendor(s). seed:demo only fills an empty database and never deletes data.
$ NODE_ENV=production pnpm seed:demo → exit 1: seed:demo is for development only: refusing to run with NODE_ENV=production.
```

The check project was torn down with its volumes afterwards.

New and changed tests:

- `apps/api/test/dashboard.e2e.test.ts` (15): session required; bad parameters (incl. `month=0000-01`); each ledger row, including a paid invoice whose payment month differs from its invoice month; needs_review not invoiced; processing/rejected nowhere; multi-currency cells; rows without amount left out; exact sums (`0.1 + 0.2 = "0.3"`); last day of the month stays in its month; the default month follows Tbilisi (2026-09-30T21:30Z → 2026-10); trend of 12 months with empty months `"0"`/0, independent of `month`; default currency by invoice count (not amount), ties alphabetical, explicit and lowercase currency, no data → null; top-5 ordering with 6+ entries and ties; attention counts, panel order equal to the list tab's default order, max 5 rows, processing included, `errorMessage`, dispute window boundaries (yesterday out, today and +3 in, +4 out), overdue/due-soon boundaries (−1 overdue, 0 and +7 soon, +8 not), extraction failures.
- `apps/api/test/seed-demo.e2e.test.ts` (2): refuses production and a non-empty database; seeds and the dashboard numbers come out as expected.
- `apps/api/test/invoice-list.e2e.test.ts`: 7-day `dueState` (today … +7 soon, +8 not), flag messages, `totals`/`withoutAmount` across pages and per tab/filter, `invoiceDateFrom=0000-01-01` refused.
- `apps/api/test/inbox.e2e.test.ts`: the flag shape with messages.
- `apps/web/src/lib/attention.test.ts` (10): each sentence clause, pluralisation, thousands, the dispute variants, overdue beating due-this-week, links and tones, the nothing-to-do case; panel reasons in priority order.
- `apps/web/src/lib/format.test.ts` (17, 13 before): amount-then-code, relative days (incl. across a month end), due and dispute phrases and colours, months, axis abbreviations.

Checks of §7:

```
$ grep -rnE "\b(Chip|Badge)\b" apps/web/src        → no output (exit 1)
$ grep -rn "components/ui\|radix-ui\|sonner" apps/web/src → no output (exit 1)
$ grep -rln "<Tag\b\|TagGroup" apps/web/src        → apps/web/src/components/tag-input.tsx (the only chips)
```

Keyboard (headless Chromium, Tab through each page, a stop passes when the element, its parent or its cells visibly change on focus):

```
light|dark /login 2 stops · / 25 · /invoices 22 · /invoices?status=unpaid 23 · /inbox 10 · /vendors 9 · /team 8
→ all 198 stops have a visible focus indicator, in both themes
```

`.review/T05b/23-keyboard-focus-*` and `24-keyboard-focus-*` show it (a table row and the segmented control).

Interaction test (headless Chromium, 1440 px, the production web build against the API built from this branch, seeded, stub extractor):

```
PASS  QA admin creates a person (API) — 201
PASS  login → set password → Home sentence — 4 invoices to review. A dispute window closes on Tue 6 Oct. 3 payments are overdue. 1 invoice couldn't be read.
PASS  "Password set" toast shows after the forced change
PASS  "N payments" link → To pay, Overdue — 3 rows
PASS  Overdue segment is selected
PASS  all 20 tab switches render (no crash)
PASS  This week → due=soon
PASS  Paid tab drops "when due" — /invoices?status=paid
PASS  Errors only → hasErrors=true
PASS  Previous month → ?month= and heading — September 2026
PASS  Next month enabled after going back
PASS  month picker back 5 and forward 5 (currency columns change)
PASS  Currency select → GEL chart — Invoiced and paid per month, GEL
PASS  Theme Dark applies and survives a reload — [true,"dark"]
PASS  /users redirects to /team
PASS  upload toast — Uploaded 1 invoice. Reading them now.
PASS  uploaded row appears and finishes reading (stub) — 4 → 5 rows, saw "Reading…": true
PASS  no page errors
```

Reduced motion: with `prefers-reduced-motion: reduce` a button's `transition-duration` is `1e-05s` (0.25 s otherwise).

Contrast (WCAG 2.x, text on canvas / on surface):

| Text    | Light           | Dark          |
| ------- | --------------- | ------------- |
| ink     | 14.86 / 16.24   | 14.89 / 13.45 |
| muted   | 5.42 / 5.93     | 7.35 / 6.64   |
| primary | 5.49 / 6.00     | 7.65 / 6.91   |
| warning | 5.05 / 5.52     | 6.29 / 5.68   |
| caution | **4.28** / 4.68 | 8.43 / 7.61   |
| ok      | 4.81 / 5.26     | 8.26 / 7.46   |

Button text: white on primary 6.00, canvas on dark primary 7.65; white on warning 5.52. Everything passes AA (4.5:1) except **light caution on the canvas, 4.28:1**. I use caution body text only on surfaces (panels, tables, where it is 4.68:1); on the canvas it appears only in the 30 px status sentence, which is large text (3:1 needed). Q2 proposes a fix. The unselected switch track is raised to ~3:1 against the canvas (WCAG 1.4.11).

## 7. Visual QA: what I fixed after looking at the screenshots

1. **Urgency colours were lost** wherever a 13 px class sat next to a colour class ("Overdue 18 days" rendered in ink): class merging treated `text-meta` as a colour. Fixed by moving the scale onto Tailwind's size names (decision 9).
2. **Home overflowed sideways by 82 px at 390 px.** Cause 1: the chart's screen-reader table had `sr-only` on the `<table>`, which tables ignore (they size to content); now the wrapper is `sr-only`. Cause 2: the ledger's minimum width; now it fits two currencies on a phone (count under the amount).
3. **The Vendor column vanished at 390 px** (the fixed columns took the whole minimum width). The table's minimum width is now the sum of the fixed columns plus 9 rem for the vendor; it scrolls inside its panel below that.
4. **The vendor and email drawers opened near the left edge.** Their width was on `Drawer.Content`, which is the full-screen layer that positions the dialog; it moved to `Drawer.Dialog`. Same fix for the phone nav drawer.
5. **The sidebar ended at the viewport height** on long pages (it was `position: fixed`): now a full-height column with a sticky inner nav.
6. **Tabs** stretched to equal widths across the page and the panel added its own inset: now natural widths, left-aligned, no inset.
7. **"Errors only" stacked its label under the switch** and pushed the filters onto a second row: the control now sits inside `Switch.Content` (as the docs' examples do, unlike its anatomy block); filter widths reduced so all fit one row at 1440 px.
8. **The vendor column was ~110 px wide at 1440** (names cut to "Kolkhi Aviation…"): column widths and cell padding rebalanced; names now wrap to two lines.
9. **The flag tooltip broke words mid-word** ("be/fore"): HeroUI's tooltip sets `break-all`; overridden.
10. **"…sent to Vendors send invoices to invoices@…"** in empty states: the address component brought its own sentence; it has an address-only variant now.
11. **"0" counts** next to "Nothing to review": hidden when zero.
12. **The status sentence wrapped inside a date** ("Tue 6 / Oct"): the date uses non-breaking spaces.
13. **Menus and popovers were ~24 px round**, off the 6/10 px system: `--radius-3xl` → 10 px.
14. **Field focus was a grey border**, not the action colour: focus border is primary now.
15. **The unselected switch track was barely visible** on white: darker track (~3:1). Also: the search placeholder was clipped; the month ledger no longer stretches across the whole panel; ranked-list names wrap instead of truncating; "This month" under the last bar no longer clips.
16. **The active sidebar item was only as wide as its label** (spotted by Otto during the run): HeroUI's `.link` is `width: fit-content`; the nav links are now full width.
17. **Switching list tabs crashed the page** ("Cell count must match column count. Found 9 cells and 10 columns", e.g. To pay → Paid). The screenshots load each tab fresh, so only the interaction test found it: the previous tab's rows stay on screen while the next tab loads, and React Aria reused its cached rows for the new columns. The table (and the month ledger, whose currency columns change by month) now passes `dependencies` so React Aria re-renders them; all 20 tab-to-tab switches pass.
18. **A second ‹/› click while a month loaded didn't move the month**: the next month came from the response, which still held the old month. It comes from the URL now.

The screenshots were taken again after 16–18, on a freshly seeded stack. Screens in `.review/T05b/` (each `-1440-light`, `-1440-dark`, `-390-light`, `-390-dark`): `00-home-empty`, `01-login`, `01-set-password`, `02-home`, `03-home-user-menu`, `04`–`09` the five tabs plus To pay → Overdue, `10-invoices-flag-tooltip`, `11-invoices-filters` (date picker at 1440, Filters popover at 390), `12-invoice-detail`, `13-inbox`, `14-inbox-email`, `15-vendors`, `16-vendor-drawer`, `17-team`, `18-team-add`, `19-upload-dialog`, `20-change-password`, `21-not-found`, `22-mobile-nav` (390 only); `23`/`24` keyboard focus (1440).

## 8. Known issues / shortcuts

- **Bundle size grew** (§2.3, Q1).
- **Flag tooltips in tables aren't keyboard-reachable for sighted users:** React Aria's grid moves focus between rows with the arrow keys and Tab leaves the table, so the icon inside a row isn't a tab stop. The row opens with Enter, and the icon's accessible name carries all the messages for screen readers. Outside tables (Inbox drawer, invoice page) it is a normal tab stop.
- **Date inputs follow the browser's locale** (mm/dd/yyyy in en-US, dd/mm/yyyy in en-GB); shown dates follow the app's "16 Sep 2026" style.
- **A one-sided date range in the URL** filters but isn't shown in the picker (decision 8).
- **Seeded invoices reuse the sample PDFs** with a few bytes appended, so "Open PDF" shows a document that doesn't match the generated data; "vendor linked" events carry the seed's time, not historical times.
- **Flag messages contain ISO dates** ("Dispute window ends 2026-10-06"), as the T04 flags write them; the tooltip shows them as stored.
- **Playwright tooling** lives in my scratchpad, not the repo (as in T05).

## 9. Questions for the CTO

1. **Bundle size.** Every route is now 284–421 kB gzip (Home's chart +98 kB lazily), against 237 kB for the whole old app. Should I trim? Options, cheapest first: import only the HeroUI component styles we use (CSS is 43.5 kB gz of it); ask HeroUI about `Input` pulling in the ComboBox stack; zod's smaller `zod/mini` in `@camex/shared` for the web.
2. **Light caution on the canvas is 4.28:1.** Keep `#A86400` (used only on surfaces, and as large text on the canvas), or darken the light token to `#A15F00` (4.63:1 on the canvas, 5.06 on white)?
3. **Passed dispute deadlines** are not in the status sentence (decision 2). Should "N dispute windows have closed" be a clause?
4. **Should Home's chart follow the picked month** (12 months ending at it) instead of always ending at the current month?
5. **Extraction failures link to Errors only** (decision 3). Add an `extraction=failed` filter later, or is that close enough?

## 10. `git diff --stat main...HEAD`

```
 .gitignore                                         |    3 +
 CLAUDE.md                                          |    2 +-
 README.md                                          |   11 +-
 apps/api/package.json                              |    3 +-
 apps/api/src/app.module.ts                         |    2 +
 apps/api/src/cli/seed-demo.ts                      | 1134 ++++++++
 apps/api/src/dashboard/dashboard.controller.ts     |   17 +
 apps/api/src/dashboard/dashboard.module.ts         |    9 +
 apps/api/src/dashboard/dashboard.service.ts        |  337 +++
 apps/api/src/evaluation/flags.ts                   |    7 +-
 apps/api/src/inbox/inbox.service.ts                |    6 +-
 apps/api/src/invoices/invoice-columns.ts           |   14 +
 apps/api/src/invoices/invoice-list.service.ts      |   88 +-
 apps/api/src/invoices/invoice-query.ts             |   20 +-
 apps/api/src/vendors/bank-accounts.ts              |    4 +-
 apps/api/test/dashboard.e2e.test.ts                |  738 ++++++
 apps/api/test/inbox.e2e.test.ts                    |   33 +
 apps/api/test/invoice-list.e2e.test.ts             |  186 +-
 apps/api/test/seed-demo.e2e.test.ts                |  129 +
 apps/web/components.json                           |   25 -
 apps/web/index.html                                |   15 +-
 apps/web/package.json                              |   11 +-
 apps/web/src/components/app-layout.tsx             |  280 +-
 apps/web/src/components/app-toasts.tsx             |   10 +
 apps/web/src/components/auth-screen.tsx            |   33 +
 apps/web/src/components/change-password-dialog.tsx |   60 +-
 apps/web/src/components/change-password-form.tsx   |   64 +-
 apps/web/src/components/combobox.tsx               |  172 --
 apps/web/src/components/flag-counts.tsx            |   77 -
 apps/web/src/components/flag-icon.tsx              |   43 +
 apps/web/src/components/form-text-field.tsx        |   75 +
 apps/web/src/components/invoice-status-badge.tsx   |   40 -
 apps/web/src/components/page-header.tsx            |   23 +-
 apps/web/src/components/panel.tsx                  |   25 +
 apps/web/src/components/require-auth.tsx           |   12 +-
 apps/web/src/components/root-layout.tsx            |   45 +
 apps/web/src/components/status-word.tsx            |   37 +
 apps/web/src/components/table-panel.tsx            |   30 +
 apps/web/src/components/tag-input.tsx              |  119 +-
 apps/web/src/components/theme-provider.tsx         |   17 +
 apps/web/src/components/tone.tsx                   |   24 +
 apps/web/src/components/truncated-text.tsx         |   50 +-
 apps/web/src/components/ui/alert.tsx               |   68 -
 apps/web/src/components/ui/badge.tsx               |   44 -
 apps/web/src/components/ui/button.tsx              |   66 -
 apps/web/src/components/ui/card.tsx                |   87 -
 apps/web/src/components/ui/dialog.tsx              |  145 --
 apps/web/src/components/ui/dropdown-menu.tsx       |  249 --
 apps/web/src/components/ui/field.tsx               |  222 --
 apps/web/src/components/ui/input.tsx               |   18 -
 apps/web/src/components/ui/label.tsx               |   18 -
 apps/web/src/components/ui/popover.tsx             |   71 -
 apps/web/src/components/ui/separator.tsx           |   25 -
 apps/web/src/components/ui/sheet.tsx               |  128 -
 apps/web/src/components/ui/sonner.tsx              |   41 -
 apps/web/src/components/ui/table.tsx               |   86 -
 apps/web/src/components/ui/tooltip.tsx             |   54 -
 apps/web/src/components/upload-invoices-dialog.tsx |  261 +-
 apps/web/src/index.css                             |  317 ++-
 apps/web/src/lib/attention.test.ts                 |  171 ++
 apps/web/src/lib/attention.ts                      |  145 ++
 apps/web/src/lib/change-password.ts                |    4 +-
 apps/web/src/lib/document-title.ts                 |    8 +
 apps/web/src/lib/format.test.ts                    |  120 +-
 apps/web/src/lib/format.ts                         |  172 +-
 apps/web/src/lib/invoice-labels.ts                 |   11 +-
 apps/web/src/lib/theme.ts                          |   18 +
 apps/web/src/lib/tone.ts                           |    8 +
 apps/web/src/lib/utils.ts                          |    1 -
 apps/web/src/main.tsx                              |   11 +-
 apps/web/src/pages/home/attention-panel.tsx        |   98 +
 apps/web/src/pages/home/home-page.tsx              |  255 ++
 apps/web/src/pages/home/home-query.ts              |   27 +
 apps/web/src/pages/home/month-ledger.tsx           |  133 +
 apps/web/src/pages/home/status-sentence.tsx        |   36 +
 apps/web/src/pages/home/trend-chart.tsx            |  183 ++
 apps/web/src/pages/inbox/email-drawer.tsx          |  106 +
 apps/web/src/pages/inbox/email-sheet.tsx           |  115 -
 apps/web/src/pages/inbox/inbox-address.tsx         |   50 +-
 apps/web/src/pages/inbox/inbox-page.tsx            |  210 +-
 apps/web/src/pages/inbox/inbox-query.ts            |    2 +-
 apps/web/src/pages/inbox/invoice-chip.tsx          |   31 -
 apps/web/src/pages/inbox/invoice-link.tsx          |   28 +
 apps/web/src/pages/invoices/invoice-filters.tsx    |  411 ++-
 apps/web/src/pages/invoices/invoice-page.tsx       |   86 +-
 apps/web/src/pages/invoices/invoices-page.tsx      |  416 +--
 apps/web/src/pages/invoices/invoices-query.ts      |    4 +-
 apps/web/src/pages/invoices/invoices-table.tsx     |  470 ++--
 apps/web/src/pages/invoices/pagination.tsx         |   85 -
 apps/web/src/pages/login-page.tsx                  |  108 +-
 apps/web/src/pages/not-found-page.tsx              |   11 +-
 apps/web/src/pages/set-password-page.tsx           |   82 +-
 apps/web/src/pages/team/add-user-dialog.tsx        |   91 +
 apps/web/src/pages/team/reset-password-dialog.tsx  |   71 +
 apps/web/src/pages/team/team-page.tsx              |  168 ++
 apps/web/src/pages/{users => team}/users-query.ts  |    0
 apps/web/src/pages/users/add-user-dialog.tsx       |  119 -
 apps/web/src/pages/users/reset-password-dialog.tsx |   86 -
 apps/web/src/pages/users/users-page.tsx            |  191 --
 apps/web/src/pages/vendors/add-vendor-dialog.tsx   |   80 +-
 apps/web/src/pages/vendors/vendor-drawer.tsx       |  277 ++
 apps/web/src/pages/vendors/vendor-fields.tsx       |  164 +-
 apps/web/src/pages/vendors/vendor-sheet.tsx        |  310 ---
 apps/web/src/pages/vendors/vendors-page.tsx        |  207 +-
 apps/web/src/router.tsx                            |   98 +-
 docs/SPEC.md                                       |   44 +-
 docs/reports/T05b-ui-overhaul.md                   |  399 +++
 docs/tasks/T05b-ui-overhaul.md                     |  229 ++
 package.json                                       |    3 +-
 packages/shared/src/dashboard.ts                   |  154 ++
 packages/shared/src/inbox.ts                       |    4 +-
 packages/shared/src/index.ts                       |    1 +
 packages/shared/src/invoice-list.ts                |   41 +-
 pnpm-lock.yaml                                     | 8458 ++++++++++++++++++++++--------------------------------------
 114 files changed, 10991 insertions(+), 9750 deletions(-)
```
