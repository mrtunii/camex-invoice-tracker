# Camex Invoice Tracker

Internal invoice intake and review tool for Camex Airlines finance. Product spec: [docs/SPEC.md](docs/SPEC.md).

## Prerequisites

Node.js 24+, pnpm 9+ (`corepack enable` picks the pinned version), Docker with Compose v2.

## Local setup

```sh
git clone <repo-url> camex-invoice-tracker && cd camex-invoice-tracker
cp .env.example .env         # then set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (see below)
pnpm install                 # also builds packages/shared and generates the Prisma client
docker compose up -d --wait  # Postgres 16 + MinIO (project "camex-invoices"); creates the bucket
pnpm db:migrate              # applies prisma/migrations to the dev database
pnpm dev                     # API on :3180, web on http://localhost:5180 (proxies /api)
```

Open http://localhost:5180 and sign in with the bootstrap admin. You are asked to set a new password first.

Local ports are deliberately off the defaults so the stack can run next to other projects: Postgres **55432**, MinIO S3 API **59000**, MinIO console **59001** (http://localhost:59001, credentials `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` from `.env`), API **3180**, Vite **5180** (`strictPort`: it fails rather than drifting to another port).

## The first admin

The primary way, and the only one in production (there is no shell there), is environment variables:

- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters), plus optionally `BOOTSTRAP_ADMIN_NAME`.
- On boot, **only if the users table is empty**, the app creates that admin and logs `bootstrap admin created: <email>`.
- That admin must choose a new password at first sign-in.
- Once any user exists, the variables are ignored (no user is ever updated, reactivated or recreated from them) and the app logs a warning until you remove them.
- Invalid values (only one of the pair, a weak password, a bad email) stop the app at boot with a clear message.

For local development you can also use the CLI instead: `pnpm create-admin --email you@camex.aero --name "Your Name"` (prompts for the password).

## Trying ingestion locally

```sh
pnpm simulate:mailgun                     # three signed "Mailgun" emails, one per fixture PDF
pnpm simulate:mailgun --file fixtures/invoices/asm.pdf --extra-attachment   # + an ignored non-PDF
pnpm simulate:mailgun --message-id '<demo@vendor>'    # run twice: the second reply is {"duplicate":true}
pnpm simulate:mailgun --bad-signature                 # 401
MAILGUN_WEBHOOK_SIGNING_KEY=… pnpm simulate:mailgun --url https://api.camex-fin.site   # a deployed API
```

The emails appear on `/inbox`. Each PDF becomes an invoice that moves from Processing to Needs review within a few seconds. Manual upload is on the same page.

## Extraction

With `EXTRACTOR_PROVIDER=stub` (the `.env.example` default) nothing is extracted and no API is called. For real extraction set `EXTRACTOR_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`; each invoice costs about $0.02 with the default `EXTRACTION_MODEL=claude-sonnet-5-5`. `GET /api/invoices/:id` returns the extracted fields.

The eval runs the real extractor and normalization on every `fixtures/invoices/<name>.pdf` that has a golden file `fixtures/invoices/expected/<name>.json`, and fails on any scored mismatch. It calls the API (needs `ANTHROPIC_API_KEY`), is not part of `pnpm test`, and should be run on every prompt or model change:

```sh
pnpm eval:extraction                                 # every fixture once
pnpm eval:extraction --fixture aeg --repeat 3        # one fixture, three times
pnpm eval:extraction --model claude-opus-5-5         # another model
```

The normalized output of the last run is written to `fixtures/invoices/eval-out/` (gitignored). The prompt is `apps/api/src/extraction/prompts/extract-v1.ts`; any change to it gets a new version.

## Flags and vendors

After every extraction the invoice is evaluated (`apps/api/src/evaluation/`): it is matched to a vendor (name or alias, else the sender's email domain), its due date and dispute deadline are derived, and the validation flags of SPEC §8 are computed. `GET /api/invoices/:id` returns `vendor`, `dueDateSource`, `disputeDeadline` and `flags`; the lists show one flag icon per invoice (red for errors, amber for warnings) with the messages in its tooltip.

Vendors are managed on `/vendors` (or `/api/vendors`). Creating or changing a vendor re-evaluates the invoices it can affect, so pending invoices link as soon as their vendor exists. Bank accounts are trusted from an invoice (in the approve dialog, or `POST /api/invoices/:id/trust-bank-details`) and removed on `/vendors`. Every open invoice is re-evaluated daily at 00:05 Asia/Tbilisi, because some flags depend on the date. `OWN_EMAIL_DOMAINS` (default `camex.aero`) lists Camex's own mail domains: they never identify a vendor.

## Home and the invoices list

The web app is built on [HeroUI v3](https://heroui.com) with one design system, the "dark cockpit" (SPEC §10): colour only where someone must act (red now, amber soon), green for paid, cyan-blue for actions and selection. Light, dark or system theme from the user menu.

`/` (Home) says what needs attention in one sentence (invoices to review, a dispute window closing, overdue payments, unreadable PDFs), lists the first invoices to review and to pay, and shows what was spent: the month by currency (invoiced, paid, to pay, to review), the last 12 months, and the month's top categories and vendors. Its data comes from `GET /api/dashboard?month=YYYY-MM&currency=XXX`, every sum computed in SQL.

`/invoices` lists invoices by status tab (To review, which includes invoices still being read · To pay · Paid · Rejected · All) with counts, filters (search over vendor, invoice #, registration and flight numbers; vendor; category; currency; invoice date range; errors only; on To pay: all, overdue or due this week), a line of totals per currency (never converted) and sortable columns. Tab, filters, sort and page are in the URL. **Export CSV** downloads the current tab, filters and sort (UTF-8 with BOM so Excel shows Georgian text; formula-like cells are prefixed with `'`; at most 10,000 rows). The API behind it: `GET /api/invoices`, `GET /api/invoices/summary` and `GET /api/invoices/export.csv`, with the query parameters of `packages/shared/src/invoice-list.ts` (unknown parameters are refused). Clicking a row opens `/invoices/:id`: the review screen (below).

## Reviewing and paying an invoice

`/invoices/:id` is where an invoice is checked and paid: the original PDF on the left (pdf.js: pages, zoom, fit width, rotate, download, open in a new tab), the extracted data on the right, in review order, with the flags as plain messages that jump to their field. On a phone the two sides are tabs. While an invoice is **To review** every field can be corrected (a field that differs from the model's reading shows what was read, with Restore); **Approve** asks only what needs a decision (link or create the vendor, trust first-seen bank details, approve despite errors); **Approve & next** moves through the queue. **To pay** invoices show the payment details with copy buttons and **Mark paid**; payments and approvals can be undone, rejected invoices reopened. Every change is in the Activity log.

The API behind it (SPEC §6): `PATCH /api/invoices/:id` and `POST /api/invoices/:id/{approve,reject,reextract,mark-paid,undo-payment,reopen}`, each carrying the invoice's `version` (409 `STALE` when someone else changed it first), plus `GET /api/invoices/:id/events` and `GET /api/invoices/next-to-review`. The state machine is `apps/api/src/invoices/workflow/`.

## Everyday commands

| Command                                               | What it does                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                            | shared (watch) + API (watch, with job workers) + web dev server                                    |
| `pnpm test`                                           | API tests against `TEST_DATABASE_URL` and `TEST_S3_BUCKET` (both reset by the run), web unit tests |
| `pnpm lint` / `pnpm format`                           | ESLint + Prettier check / write                                                                    |
| `pnpm typecheck`                                      | `tsc --noEmit` in every workspace                                                                  |
| `pnpm build`                                          | build every workspace (`apps/api/dist`, `apps/web/dist`)                                           |
| `pnpm db:migrate`                                     | apply committed migrations (`prisma migrate deploy`)                                               |
| `pnpm db:migrate:dev --name <name>`                   | create a new migration from `schema.prisma` changes                                                |
| `pnpm simulate:mailgun [flags]`                       | signed Mailgun webhook POSTs to the local API (`--help` for flags)                                 |
| `pnpm eval:extraction [flags]`                        | extraction eval against the golden files (calls the Anthropic API; `--help`)                       |
| `pnpm create-admin --email … --name … [--password …]` | create an admin from the command line (local development)                                          |
| `pnpm seed:demo`                                      | fill an empty development database with demo invoices over 12 months (refuses in production)       |

Background jobs (extraction, recovery sweep) run in the API process on pg-boss, in the `pgboss` schema of the same database. Set `WORKERS_ENABLED=false` to run an API process without workers.

## Deployment

Two images built from this repo, deployed as two Dokploy applications behind Traefik: the API (`apps/api/Dockerfile`, runs migrations on start) and the web app (`apps/web/Dockerfile`, nginx, reads its API URL at container start). Both use the repo root as build context. The runbook, with every environment variable, is [docs/deploy.md](docs/deploy.md).

```sh
docker build -f apps/api/Dockerfile -t camex-api .
docker build -f apps/web/Dockerfile -t camex-web .
```
