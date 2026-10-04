# Camex Invoice Tracker

Internal invoice intake and review tool for Camex Airlines finance. Product spec: [docs/SPEC.md](docs/SPEC.md).

## Prerequisites

Node.js 24+, pnpm 9+ (`corepack enable` picks the pinned version), Docker with Compose v2.

## Local setup

```sh
git clone <repo-url> camex-invoice-tracker && cd camex-invoice-tracker
cp .env.example .env
pnpm install                 # also builds packages/shared and generates the Prisma client
docker compose up -d --wait  # Postgres 16 + MinIO; creates the bucket
pnpm db:migrate              # applies prisma/migrations to the dev database
pnpm create-admin --email you@camex.aero --name "Your Name"   # prompts for a password (min 12 chars)
pnpm dev                     # API on :3000, web on http://localhost:5173 (proxies /api)
```

Open http://localhost:5173 and sign in with the admin you just created. (If port 5173 is busy, Vite picks the next free port and prints it.)

## Everyday commands

| Command                                               | What it does                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm dev`                                            | shared (watch) + API (watch) + web dev server                    |
| `pnpm test`                                           | API tests against `TEST_DATABASE_URL` (created/migrated for you) |
| `pnpm lint` / `pnpm format`                           | ESLint + Prettier check / write                                  |
| `pnpm typecheck`                                      | `tsc --noEmit` in every workspace                                |
| `pnpm build` then `NODE_ENV=production pnpm start`    | production build; the API serves the SPA on :3000                |
| `pnpm db:migrate`                                     | apply committed migrations (`prisma migrate deploy`)             |
| `pnpm db:migrate:dev --name <name>`                   | create a new migration from `schema.prisma` changes              |
| `pnpm create-admin --email … --name … [--password …]` | create an admin (the only way to create the first user)          |

MinIO console: http://localhost:9001 (credentials are `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` from `.env`).
