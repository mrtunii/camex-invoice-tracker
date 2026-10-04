# Camex Invoice Tracker

Internal tool for Camex Airlines finance: vendor invoice PDFs arrive by email, an LLM extracts them, a human checks each against the original, then it is tracked unpaid → paid. **docs/SPEC.md is the source of truth.** Implement only the current task (SPEC §13). If the spec looks wrong or ambiguous, pick the simplest option and record it in the report; never silently redesign.

Layout: pnpm workspaces. `apps/api` NestJS 12 (ESM) + Prisma 7 · `apps/web` React + Vite + shadcn/ui · `packages/shared` zod schemas and types used by both. Run `pnpm dev`, `pnpm test` (needs `docker compose up -d --wait`), `pnpm lint`, `pnpm typecheck`; new migration: `pnpm db:migrate:dev --name <name>`.

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

Report rule: when a task is done, write `docs/reports/Txx-<slug>.md` with: Summary · What was built · Deviations (with reasons) · Decisions not in the spec · How to verify (exact commands from a clean clone, expected result) · Test results (command + output) · Known issues / shortcuts · Questions for the CTO. Be factual: don't claim anything works unless you ran it.
