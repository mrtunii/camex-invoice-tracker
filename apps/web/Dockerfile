# syntax=docker/dockerfile:1
# Web image: the built SPA on nginx (non-root, port 8080). Build context is the repo root:
#   docker build -f apps/web/Dockerfile -t camex-web .
# Runtime env: API_BASE_URL (required), INBOX_ADDRESS (optional); see docs/deploy.md.

FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Package downloads depend on the lockfile only, so this layer survives source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .
# Only the web app and what it depends on. --ignore-scripts skips the root postinstall, which
# would generate the API's Prisma client; the shared package is built explicitly instead.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --ignore-scripts --filter '@camex/web...' \
 && pnpm --filter @camex/shared build \
 && pnpm --filter @camex/web build


FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY apps/web/docker/default.conf /etc/nginx/conf.d/default.conf
COPY apps/web/docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/docker/40-app-config.sh /docker-entrypoint.d/40-app-config.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Everything is root-owned and read-only for nginx (uid 101), except config.js, which
# 40-app-config.sh rewrites at every start (dist/config.js is the dev version until then).
USER root
RUN rm -f /usr/share/nginx/html/50x.html \
 && chown 101:101 /usr/share/nginx/html/config.js \
 && chmod 0755 /docker-entrypoint.d/40-app-config.sh
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
