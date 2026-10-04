# T05b — UI overhaul on HeroUI v3 + Home page

You are implementing task T05b of the Camex Invoice Tracker. Read CLAUDE.md, docs/SPEC.md (§6, §10) and this file before writing code.

**Why this task.** Otto reviewed the UI. Three problems:
1. There is no home page that says what needs attention and what was spent.
2. It isn't on HeroUI, which he wants.
3. It uses too many badges.

The product must feel very simple. This task rebuilds every existing screen on HeroUI v3 with one design system and adds Home. **No API behaviour changes**, except the new dashboard endpoint and the small list changes in §5.

## 0. Git: merge the accepted T05 first

The CTO has reviewed and accepted `t05-invoices-list`.

```sh
git checkout main
git pull --ff-only
git merge --ff-only t05-invoices-list
git push origin main
```

- Any failure → stop and ask. Never force-push, rebase, reset `main` or create merge commits.
- Only `docs/tasks/T05b-ui-overhaul.md` (CTO-provided) may be untracked; anything else → stop and ask.
- Create branch `t05b-ui-overhaul`. Commit this file with the task. One commit "T05b: UI overhaul + home". Don't merge or push it.
- Report the git commands and their output, as in T05.

## 1. HeroUI v3

- HeroUI v3 (stable since March 2026) is a rewrite on React Aria Components and Tailwind CSS v4. The packages are `@heroui/react` and `@heroui/styles`; the CSS imports are `@import "tailwindcss"; @import "@heroui/styles";`.
- Components are compound. **Don't write v2 APIs from memory.** Before using a component, read its page in the official docs (`https://heroui.com/llms-full.txt` or heroui.com/docs). Report the version you installed.
- **Remove** shadcn/ui and everything only it used: `components/ui/*`, `radix-ui`, `class-variance-authority`, `shadcn`, `sonner` (use HeroUI Toast), `tw-animate-css`, and any utility left unused. When done, `grep -r "components/ui\|radix-ui\|sonner" apps/web/src` must return nothing.
- **Keep** react-router, TanStack Query, react-hook-form + zod (wire HeroUI fields as controlled inputs), and the Atkinson fonts.
- **Add** `recharts` for the one chart on Home (check React 19 support for the version you install). No other UI libraries.
- **Code splitting:** lazy-load each page route (`React.lazy`), so the chart and HeroUI's heavier components don't load on `/login`. Report the bundle sizes before and after.

## 2. Design system: "dark cockpit"

The concept comes from aviation. In a dark cockpit, a light only comes on when the crew must act. This app works the same way: **when nothing is wrong, nothing is coloured.** Colour means exactly one thing, as on an annunciator panel:

| Colour | Meaning | Used for |
|---|---|---|
| red | warning: act now | overdue, dispute window passed, error flags |
| amber | caution: act soon | due within 7 days, dispute window closing within 3 days, warning flags |
| green | done | paid (sparingly: a dot or the word, never a filled block) |
| cyan-blue | selected / action | primary buttons, links, focus, the active tab and nav item |

Everything else is neutral.

**Tokens.** Map them onto HeroUI's CSS variables (OKLCH); the hex values are the source.

| Token | Light | Dark |
|---|---|---|
| canvas (app background) | `#F3F5F7` | `#11161C` |
| surface (panels, tables) | `#FFFFFF` | `#18202A` |
| ink (text) | `#18212C` | `#E4E9EF` |
| muted (secondary text) | `#5A6573` | `#9AA6B4` |
| line (borders) | `#DCE1E7` | `#2A3441` |
| primary (cyan-blue) | `#0A6A94` | `#4FB3DE` |
| warning (red) | `#C0362C` | `#F07167` |
| caution (amber) | `#A86400` | `#E8A33D` |
| ok (green) | `#2D7A4A` | `#5CC28A` |

- Text colours must meet WCAG AA on their background; check them and report.
- **Theme:** follow the system setting, with a Light / Dark / System choice in the user menu, stored in localStorage.

**Typography**
- Atkinson Hyperlegible Next for everything; it was designed for character legibility. Use tabular figures (`font-variant-numeric: tabular-nums`) for every amount and date column.
- Atkinson Hyperlegible Mono only for identifiers where 0/O and 1/l confusion matters: invoice numbers, IBAN, account numbers, SWIFT, flight numbers, registrations.
- Scale (px): 13 (meta), 14 (body, tables), 16 (section titles), 20 (page titles), 30 (the Home status sentence, weight 500, tight leading).
- Sentence case everywhere. No ALL-CAPS labels, no letter-spaced eyebrows, no labels above headings.

**Shape and depth**
- Radius: 6 px for inputs and buttons, 10 px for panels and the table container. Don't use one radius on everything.
- No drop shadows on panels. Panels separate from the canvas by the surface/canvas contrast and a 1 px line. Shadows are for overlays only (menus, modals, drawers).

**Layout**
- Left sidebar, 224 px. It collapses to icons below 1024 px and becomes a drawer below 640 px.
  - Top: Home, Invoices, Inbox, Vendors.
  - Bottom: Team (the current Users page), then the user menu (theme, change password, sign out).
- Content left-aligned, max width 1280 px, generous whitespace.
- Page header: the page title, and at most one primary action on the right.

**Badge rules.** This is the main complaint.
- **Lists show no pills, chips or badges.** Allowed exceptions:
  - removable tags in tag inputs (vendor aliases and domains);
  - the count inside a tab label ("To review 3"), as plain muted text, not a pill.
- **Status in lists:** the tab already says it. The "All" tab gets a plain "Status" column: a 6 px dot plus the word.
- **Flags in lists:** at most one small icon per row.
  - Red if the row has any error flag, else amber if it has any warning flag, else nothing. Info flags are never shown in lists.
  - The tooltip lists the flag *messages* in plain English.
  - Never show flag codes (`BANK_FIRST_SEEN` …) anywhere in the UI. They stay in the API and CSV.
- **Urgency** is shown by coloured text on the date itself ("Overdue 3 days", "Due Fri 9 Oct"), never by a chip.
- **Unmatched vendor:** in lists, just the extracted name, no "New" badge. The detail view (T06) handles linking.
- **Processing:** a small spinner and "Reading…" in muted text.

**Words** (one vocabulary everywhere: tabs, Home, toasts, empty states)

| Status | Shown as |
|---|---|
| `needs_review` | "To review" |
| `unpaid` | "To pay" |
| `paid` | "Paid" |
| `rejected` | "Rejected" |

- Write dates relative when they are close ("Tomorrow", "Fri 9 Oct", "Overdue 3 days"), else "16 Sep 2026".
- Amounts: "15,617.79 USD": amount, then code, never a symbol. Never add different currencies together.
- Empty states say what to do: "Nothing to review. New invoices sent to invoices@… appear here."

## 3. Home (`/`, new default route)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 3 invoices to review. A dispute window closes tomorrow.             │ ← the status sentence (30 px)
│ 2 payments are overdue.                              [Upload PDFs]  │
│                                                                      │
│ ┌ To review ─────────────── 3 ┐  ┌ To pay ──────────────────── 8 ┐  │
│ │ AEG Fuels        6,461.29 USD│  │ ASM Aviation   15,617.79 USD  │  │
│ │ Dispute window closes tmrw   │  │ Overdue 18 days               │  │
│ │ Petrocas        88,753.98 GEL│  │ Petrocas       88,753.98 GEL  │  │
│ │ Due date missing             │  │ Due Fri 9 Oct                 │  │
│ │ …                View all    │  │ …                  View all   │  │
│ └──────────────────────────────┘  └───────────────────────────────┘  │
│                                                                      │
│ October 2026   ‹ ›                                                   │
│                    USD            GEL                                │
│ Invoiced     56,153.08 (12)  88,753.98 (1)                           │ ← a ledger table, not KPI cards
│ Paid         21,000.00 (4)        —                                  │
│ To pay       35,153.08 (8)   88,753.98 (1)                           │
│ To review     6,461.29 (2)        —                                  │
│                                                                      │
│ Last 12 months  [USD ▾]          By category        Top vendors      │
│ ▂▃▅▂▆▇▃▅▆▄▅▇  invoiced / paid    Fuel 52,100        AEG  6,461       │
└──────────────────────────────────────────────────────────────────────┘
```

**The status sentence** is the one bold element on the page.
- Built from the data, in plain words. Only clauses with something to say:
  - to-review count, plus the most urgent dispute deadline;
  - overdue payments, else payments due this week;
  - extraction failures.
- When nothing needs attention: "Nothing needs attention." in neutral ink, no colour.
- Numbers in the sentence are links to the matching filtered list. The rest of the page stays quiet.

**To review / To pay panels**
- Up to 5 rows each, ordered as the list's default sort.
- Each row: vendor, amount, and one line of plain-language reason. To review: the most urgent of dispute deadline, error flag message, extraction failed. To pay: overdue / due date.
- "View all" → the list tab. A row → `/invoices/:id`.

**Month ledger** (month picker, default the current month in Tbilisi). One column per currency that has data; cells show the amount and the count.

| Row | Definition |
|---|---|
| Invoiced | status `unpaid` or `paid`, `invoice_date` in the month, sum of `amount_due` by `amount_due_currency` |
| Paid | status `paid`, `paid_at` in the month (cash basis, regardless of invoice date) |
| To pay | of the month's invoiced, those still `unpaid` |
| To review | `needs_review` with `invoice_date` in the month (not yet counted as invoiced) |

A one-line note under the table: "By invoice date; paid by payment date."

**Chart: last 12 months**
- Recharts grouped bars: invoiced and paid per month for one currency.
- The currency select defaults to the currency with the highest invoiced count in the period.
- Invoiced = primary colour; paid = muted ink.
- No gridlines except a faint baseline. Tooltip with exact amounts. Axis amounts abbreviated ("56k").
- The current month is labelled; the bars are not highlighted.
- Accessible: a visually hidden table with the same data.

**By category / Top vendors** (selected month and currency): two simple ranked lists (name + amount), top 5, plain text, no bars.

**API: `GET /api/dashboard?month=YYYY-MM&currency=XXX`** (session required)
- Returns `attention` (counts and the top-5 rows for both panels, overdue and due-this-week counts, extraction-failure count), `ledger`, `trend` (12 months for the currency), `categories` and `topVendors`.
- All sums in SQL (exact numeric, strings in JSON). "Today" and month boundaries in Asia/Tbilisi (business dates; `paid_at` is a date).
- Zod schemas in `packages/shared`. `currency` is optional (server picks the default as above and returns it).

## 4. Screens to migrate (same behaviour, new look)

- **Login and set password:** a centred form on the canvas, the Camex Invoices wordmark in type (no logo image), no card shadow.
- **Invoices list:**
  - Tabs: To review, To pay, Paid, Rejected, All.
  - Filters on one row: search, vendor, category, currency, date range, "Errors only" switch. Less-used filters may sit behind a "Filters" popover on narrow screens.
  - To pay tab: a segmented control "All · Overdue · This week" replaces the summary strip links.
  - Above the table, one quiet line of totals for the current tab and filters: "8 invoices · 35,153.08 USD · 88,753.98 GEL".
  - Table: HeroUI Table with sortable headers and the badge rules; Pagination.
- **Inbox:** Otto likes it; keep the structure. Invoice chips become plain links: file name + status word in muted text + flag icon per the rules. The email body opens in a Drawer.
- **Vendors:** table + Drawer for edit; tag inputs for aliases and domains; trusted accounts with identifiers in mono; Remove behind an AlertDialog.
- **Team** (Users): table, add / reset-password dialogs as Modals.
- **Upload dialog, change-password dialog, toasts, not-found page.**
- **Interim `/invoices/:id`:** same content as now, restyled (T06 replaces it).

## 5. Small API and list changes (T05 questions)

1. **"Due soon" is 7 days everywhere** (amber text, `dueState: soon`, the This week filter). The dispute window keeps 3 days (DISPUTE_SOON). Update SPEC §6/§10.
2. **The summary strip is gone.** Its counts now live on Home, and the To pay segmented control replaces the `due` links. Keep the `due` filter in the API.
3. **All tab:** a plain Status column (dot + word), per §2.

## 6. SPEC edits

- §10 (UI): rewrite to match this task. Add Home, the design principles (dark cockpit, colour meanings, badge rules, vocabulary) and the screen list. Keep it concise; this file has the details.
- §6: due soon = 7 days.
- §13: add the T05b row.

## 7. Tests and visual QA

- **API:** dashboard endpoint, covering ledger definitions per row (including a paid invoice whose payment month differs from its invoice month), multi-currency, month boundaries in Tbilisi (an invoice dated the last day of the month), trend over 12 months with empty months as zero, default currency choice, top-5 ordering, and the attention sentence data. Update the list tests for the 7-day change.
- **Web:** unit tests (Node runner) for the status-sentence builder (each clause, pluralisation, the nothing-to-do case) and the relative-date formatter.
- **Visual QA is required.**
  - Seed a realistic dataset: the three fixtures plus about 25 generated invoices across 12 months, statuses and two currencies. Use a dev-only seed script, `pnpm seed:demo`, refusing to run when `NODE_ENV=production`.
  - With Playwright (outside the repo), screenshot every screen at 1440 px and 390 px, light and dark, plus one empty-state Home.
  - Save them to `.review/T05b/` in the repo root. Add `.review/` to `.gitignore`; the CTO reviews them there.
  - Look at your own screenshots and fix what looks wrong before writing the report. List what you fixed.
- **Checks:**
  - keyboard: tab through each page and confirm visible focus;
  - `prefers-reduced-motion` respected;
  - a `grep` showing no `Chip`/`Badge` usage outside tag inputs.

## Out of scope

The invoice detail split view and actions (T06), new filters, notifications, multi-currency conversion.

## Done when

- Every screen above is on HeroUI v3 with the tokens and rules in §2, and no shadcn or Radix code remains.
- Home shows the status sentence, both panels, the month ledger, the chart and the two ranked lists from real data.
- Screenshots for all screens are in `.review/T05b/`.

## Report

`docs/reports/T05b-ui-overhaul.md` with the sections from CLAUDE.md, the §0 git log, the HeroUI version, bundle sizes before and after, the contrast checks, the list of visual fixes, and `git diff --stat main...HEAD`. Don't claim anything works unless you ran it.
