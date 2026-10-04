// Runtime configuration for local development (`pnpm dev`): "" keeps API calls on /api, which the
// Vite dev server proxies to the API. The web image generates this file at container start from
// API_BASE_URL and INBOX_ADDRESS instead (apps/web/docker/40-app-config.sh).
window.__APP_CONFIG__ = { apiBaseUrl: '', inboxAddress: null };
