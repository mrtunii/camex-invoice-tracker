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

## Everyday commands

| Command                                               | What it does                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`                                            | shared (watch) + API (watch, with job workers) + web dev server                    |
| `pnpm test`                                           | API tests against `TEST_DATABASE_URL` and `TEST_S3_BUCKET` (both reset by the run) |
| `pnpm lint` / `pnpm format`                           | ESLint + Prettier check / write                                                    |
| `pnpm typecheck`                                      | `tsc --noEmit` in every workspace                                                  |
| `pnpm build` then `NODE_ENV=production pnpm start`    | production build; the API serves the SPA on `PORT`                                 |
| `pnpm db:migrate`                                     | apply committed migrations (`prisma migrate deploy`)                               |
| `pnpm db:migrate:dev --name <name>`                   | create a new migration from `schema.prisma` changes                                |
| `pnpm simulate:mailgun [flags]`                       | signed Mailgun webhook POSTs to the local API (`--help` for flags)                 |
| `pnpm eval:extraction [flags]`                        | extraction eval against the golden files (calls the Anthropic API; `--help`)       |
| `pnpm create-admin --email … --name … [--password …]` | create an admin from the command line (local development)                          |

Background jobs (extraction, recovery sweep) run in the API process on pg-boss, in the `pgboss` schema of the same database. Set `WORKERS_ENABLED=false` to run an API process without workers.
