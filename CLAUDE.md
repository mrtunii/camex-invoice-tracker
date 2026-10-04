# Camex Invoice Tracker

Internal tool for Camex Airlines finance: vendor invoice PDFs arrive by email, an LLM extracts them, a human checks each against the original, then it is tracked unpaid → paid. **docs/SPEC.md is the source of truth.** Implement only the current task (SPEC §13). If the spec looks wrong or ambiguous, pick the simplest option and record it in the report; never silently redesign.

Layout: pnpm workspaces. `apps/api` NestJS 12 (ESM) + Prisma 7 · `apps/web` React + Vite + shadcn/ui · `packages/shared` zod schemas and types used by both. Run `pnpm dev` (API :3180, web :5180), `pnpm test` (needs `docker compose up -d --wait`), `pnpm lint`, `pnpm typecheck`, `pnpm simulate:mailgun`; new migration: `pnpm db:migrate:dev --name <name>`. Sample invoices: `fixtures/invoices/` (don't modify).

Conventions:

- TypeScript strict, no `any`.
- Money, quantities and prices are never JS numbers: Prisma Decimal in the DB, strings in JSON.
- Calendar dates (invoice_date etc.) are 'YYYY-MM-DD' strings end to end.
- "Today" in business logic means Asia/Tbilisi.
- All API input is validated with zod schemas from packages/shared (`ZodValidationPipe`).
- Every /api route requires a session unless marked `@Public()`.
- Never log bank details, file contents, passwords or cookies.
- Nest DI: never turn constructor-injected imports into `import type` (it erases the DI metadata).
- Only add dependencies the task needs; justify notable ones in the report.

Safety rules (shared dev machine):

- Never stop processes you didn't start. No pattern-based kills (`pkill -f`, `killall`); stop only PIDs you recorded.
- Never run destructive commands against the dev environment (`docker compose down -v`, resetting the dev DB, deleting the bucket, `rm` outside the repo) without asking first.
- Clean-clone checks run in a temp directory under a separate compose project (`docker compose -p camex-invoices-check`). Tear down only that project.
- Never write credentials into reports, README or committed files.
- S3 code uses only the standard S3 API; path-style addressing is a config flag.

Report rule: when a task is done, write `docs/reports/Txx-<slug>.md` with: Summary · What was built · Deviations (with reasons) · Decisions not in the spec · How to verify (exact commands from a clean clone, expected result) · Test results (command + output) · Known issues / shortcuts · Questions for the CTO. Be factual: don't claim anything works unless you ran it.
