# syntax=docker/dockerfile:1
# API image: the NestJS API with its job workers; applies migrations on start. Build context is
# the repo root:
#   docker build -f apps/api/Dockerfile -t camex-api .
# Configuration is runtime env only (see docs/deploy.md); nothing environment-specific is baked in.

# Debian slim, not alpine: Prisma's schema engine and argon2 ship glibc binaries.
FROM node:24-bookworm-slim AS base
# OpenSSL for Prisma's schema engine (migrations); CA certificates for its TLS to a hosted
# Postgres (Node itself uses its bundled CA list).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*


FROM base AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Package downloads depend on the lockfile only, so this layer survives source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .
# Install the API and its workspace dependencies, build, then `pnpm deploy` a standalone copy
# with production dependencies only (package.json "files": dist, prisma, prisma.config.ts).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter '@camex/api...' \
 && pnpm --filter @camex/shared build \
 && pnpm --filter @camex/api prisma:generate \
 && pnpm --filter @camex/api build \
 && pnpm --filter @camex/api deploy --prod /out

# Trim what neither the API nor `prisma migrate deploy` loads (about 210 MB): the Prisma CLI's
# optional peers (typescript, react) and the pieces only `prisma dev` and Studio use (pglite,
# elkjs), the query-compiler wasm of the other databases, type declarations and source maps.
# The CLI does load @prisma/studio-core and @prisma/dev at startup, so those stay. Every start
# runs `prisma migrate deploy`, so a Prisma upgrade that needs something removed here fails loudly.
RUN cd /out/node_modules/.pnpm \
 && rm -rf typescript@* react@* react-dom@* @electric-sql+pglite@* elkjs@* \
 && find @prisma+client@*/node_modules/@prisma/client/runtime prisma@*/node_modules/prisma/build \
      -type f \( -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' -o -name '*cockroachdb*' \) -delete \
 && find /out/node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete


FROM base
ENV NODE_ENV=production \
    PORT=3000
# The repo layout is kept (/app/apps/api), so paths the code resolves relative to itself still
# work: the CLIs find /app/fixtures/invoices, and there is no /app/.env to load.
WORKDIR /app/apps/api
# Root-owned and read-only for the app user.
COPY --from=build /out ./
# For `node dist/cli/simulate-mailgun.js` inside the container (the three sample PDFs, ~0.5 MB).
COPY fixtures/invoices/*.pdf /app/fixtures/invoices/
COPY --chmod=0755 apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(4000) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["docker-entrypoint.sh"]
