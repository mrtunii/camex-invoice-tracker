import { z } from 'zod';

/**
 * Runtime configuration from /config.js, which index.html loads before the bundle. The same
 * build runs everywhere: in dev it is public/config.js; in the web image it is generated at
 * container start from API_BASE_URL and INBOX_ADDRESS (docker/40-app-config.sh).
 */
const appConfigSchema = z.object({
  /** The API's base URL, e.g. https://api.camex-fin.site; "" for same-origin /api (Vite proxy). */
  apiBaseUrl: z.string().refine((value) => !value.endsWith('/'), 'no trailing slash'),
  /** Where vendors send invoices, shown on /inbox; null hides it. */
  inboxAddress: z.string().min(1).nullable(),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

declare global {
  interface Window {
    __APP_CONFIG__?: unknown;
  }
}

function loadConfig(): AppConfig {
  const result = appConfigSchema.safeParse(window.__APP_CONFIG__);
  if (!result.success) {
    throw new Error(
      `/config.js is missing or invalid (window.__APP_CONFIG__): ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export const appConfig: AppConfig = loadConfig();

/** Absolute URL of an API path: apiUrl('/invoices/1/file') → `${apiBaseUrl}/api/invoices/1/file`. */
export function apiUrl(path: string): string {
  return `${appConfig.apiBaseUrl}/api${path}`;
}
