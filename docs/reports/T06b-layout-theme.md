# T06b — Centred layout, light default, grey nav highlight, theme toggle, To pay when nothing to review

Branch `t06b-layout-theme` from `main` at `3a8781b` (= `origin/main`, T06 already merged), one commit "T06b: centred layout, light theme, To pay when nothing to review". Not merged, not pushed. Requested directly by the CTO in chat, not from a task file (the To pay change came in a follow-up message and was folded into the same commit).

## 1. Summary

- **Centred content.** The page column is centred in the space beside the sidebar and may grow to 1440 px (was 1280 px, left-aligned). On a 14" MacBook Pro (1512 px wide) it fills the space as before. On wider windows the spare space is split evenly on both sides instead of all piling up on the right. On a 2560 px display it stays 1440 px wide, centred. The invoice split view stays full width.
- **Light is the default theme.** Until someone picks a theme, the app is light, whatever the OS setting. Light / Dark / System stays in the user menu.
- **Light/dark toggle** (sun/moon icon) beside the "Camex Invoices" wordmark. In the icon-only sidebar (640–1023 px) it sits above the avatar.
- **The current nav item is grey**, not cyan-blue. Font weight and a neutral background mark it; hover is a lighter grey.
- **Invoices opens To pay when nothing is left to review.** Arriving on the plain list (sidebar link, or "Approve & next" after the last review) shows To pay when To review is empty and To pay isn't. Clicking To review, or a link that asks for a tab or filter (Home's "couldn't be read" link, `?status=…`), is left alone.
- SPEC §10 updated to match: theme default, toggle, nav item no longer listed under cyan-blue, centred layout at most 1440 px, the Invoices arrival rule.

## 2. What was built

| File                                              | Change                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/app-layout.tsx`          | `main` gets `mx-auto max-w-[1440px]`; `ThemeToggle` (HeroUI `Button` + `Tooltip`, lucide `Sun`/`Moon`); active nav item `bg-default font-medium` instead of `bg-primary/10 text-primary`, hover `bg-default/60`.                                                                                                                                                    |
| `apps/web/src/components/theme-provider.tsx`      | `useTheme('light')` (was `'system'`); exposes `resolved` (what is on screen) for the toggle.                                                                                                                                                                                                                                                                        |
| `apps/web/src/lib/theme.ts`                       | `ThemeState.resolved: 'light' \| 'dark'`.                                                                                                                                                                                                                                                                                                                           |
| `apps/web/index.html`                             | The pre-paint script falls back to `light` (was `system`), so the first paint matches the React default.                                                                                                                                                                                                                                                            |
| `apps/web/src/pages/invoices/list-params.ts`      | `isArrival(search, madeByList)` and `arrivalStatus(counts)`: the rule, as pure functions.                                                                                                                                                                                                                                                                           |
| `apps/web/src/pages/invoices/list-params.test.ts` | New: 6 unit tests for both.                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/pages/invoices/invoices-page.tsx`   | The list marks its own URL changes (tabs, filters, sort, pages) with history state `{ madeByList: true }`. An unmarked plain `/invoices` is an arrival: the page waits for fresh summary counts, then replaces the entry with the chosen tab (keeping "All caught up" after Approve & next). Until then the table shows its loading state, not "Nothing to review". |
| `docs/SPEC.md`                                    | §10 design principles, layout, and the Invoices tabs line.                                                                                                                                                                                                                                                                                                          |

The toggle flips what is on screen: with "System" on a dark Mac it offers "Switch to light theme" and then stores `light`. HeroUI writes `heroui-theme` to localStorage only when the user picks a theme, so everyone who never picked one gets the new default.

**Why the arrival needs a marker and fresh counts.** To review is the default tab, so it is left out of the URL: a click on To review and an arrival from the sidebar both produce a plain `/invoices`. The history-state marker tells them apart, so an empty To review that the user clicked stays put; it survives reload, and Back/Forward restore it per entry. Counts are taken only once the summary query is not fetching: the cached summary on the way back from "Approve & next" predates the approval (staleTime 0, so React Query refetches on mount). Replacing the arrival entry records the decision, so Back skips it and a reload doesn't decide again.

## 3. Deviations

None from the requests. SPEC §10 changed with them (CTO requests).

## 4. Decisions not in the spec

- **1440 px cap** (confirmed by the CTO). With a 224 px sidebar, the sidebar plus content cover 100% of the width at 1512 px, 96% at 1728 px (16"), 92% at 1800 px (14" "More space"), 87% at 1920 px and 65% at 2560 px.
- **The sidebar stays at the left edge**; only the content column is centred. Centring the whole app would leave the sidebar floating mid-screen on large displays.
- **Toggle placement.** First tried in the footer beside the user menu; it truncated the name and email ("Nino Berid…"), so it moved up beside the wordmark.
- **Active tabs stay cyan-blue** (confirmed by the CTO).
- **Both tabs empty:** stays on To review (its empty state says where invoices come from). **To review has only `processing` invoices:** stays on To review (they count as To review).
- **Only the plain list redirects.** A URL with any query (a tab, a filter, a page) is what was asked for. Example: Home's "1 invoice couldn't be read" link (`?extraction=failed`) stays on To review even if that invoice was meanwhile approved.

## 5. How to verify

```sh
pnpm install && docker compose up -d --wait && pnpm db:migrate && pnpm seed:demo   # empty dev DB
pnpm dev                                                                            # web :5180
```

1. In a fresh browser profile (or after `localStorage.removeItem('heroui-theme')`), with macOS in Dark mode: the app opens light.
2. Widen the window past ~1750 px: the content has equal margins left and right. At 1512 px it fills the space beside the sidebar.
3. The current page in the sidebar has a grey background, no blue.
4. Click the moon beside "Camex Invoices": dark; reload: still dark. Click the sun: light. User menu → Theme → System follows the OS, and the toggle offers the opposite of what is shown.
5. Review or reject everything in To review, approving the last with **Approve & next**: the list opens on To pay with "All caught up". Go to Vendors, then Invoices in the sidebar: To pay. Click To review: it stays, showing "Nothing to review", also after a reload.

## 6. Test results

- `pnpm lint`: clean (eslint + prettier).
- `pnpm --filter @camex/web typecheck`: clean.
- `pnpm --filter @camex/web test`: 65 passed, 0 failed (59 before + 6 new).
- `pnpm --filter @camex/web build`: built.
- API untouched; the API suite was not re-run.
- Browser check, layout and theme (Playwright, check stack: API 3181, web 5181), 16 checks, all ok: light default with the OS in dark mode and nothing stored; active nav item not accent-coloured; toggle → dark, persists across reload, → light; menu "System" follows the OS and the toggle then offers light; toggle works in the icon-only sidebar (900 px) and the mobile drawer (390 px); no horizontal overflow; no page errors.
- Browser check, To pay on arrival (production build via `vite preview`, data reset to the demo seed, the other four review invoices rejected through the API), 16 checks, all ok: one left to review → stays on To review; **Approve & next** on it (creating its vendor in the dialog) → To pay, "All caught up" shown, the invoice listed; sidebar from Vendors → To pay without "All caught up"; a DOM observer saw no "Nothing to review" during either arrival; clicking To review stays (1.5 s), also after reload; Back → To pay, Back again → Vendors; `?extraction=failed` left alone; no page errors.
- Timing, frame by frame (3 runs): click → To pay selected in 133–202 ms; the URL is replaced one frame (~15 ms) before the tab re-renders (React Router navigations run as transitions); "Nothing to review" never on screen.
- Measured content position (sidebar 224 px): 1512 px → x 224, width 1288; 1728 → 256 / 1440 (32 px each side); 1800 → 292 / 1440 (68 each side); 2560 → 672 / 1440 (448 each side). Before: always x 224, width 1280, the rest on the right.
- Screenshots reviewed at 1512, 1728, 1800, 2560 (light), 1512 dark, 900 px compact, 390 px drawer, and the To pay arrival.

## 7. Known issues / shortcuts

- The grey active state in dark mode is subtle (`--default` on the sidebar surface). It is visible, but if it should stand out more, `--default` or a dedicated token can be raised.
- While an arrival waits for fresh counts (one summary request), To review is selected and the table shows its loading state; then To pay. Locally that is about 150 ms.
- No component tests for the layout or the page; the browser checks above cover them (kept in the session scratchpad, not in the repo, as in earlier tasks).
- **Not from this change, seen during QA:** on the Vite dev server, opening an invoice crashed once with `The requested module '/node_modules/.vite/deps/pdfjs-dist_build_pdf__worker__min__mjs_….js' does not provide an export named 'default'` (the `?url` import of pdf.js's worker in `pdf-viewer.tsx`, after Vite re-optimised its dependencies mid-session). The first visit had worked. The production build (`vite preview`) is fine, which is why UI QA uses it. Not investigated further.

## 8. Questions for the CTO

None open (1440 px and blue tabs confirmed).
