import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { type DynamicModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { Env } from './config/env.js';

/**
 * Production only: serve the built SPA (apps/web/dist) with history fallback to index.html.
 * /api/* is excluded so unknown API routes stay JSON 404s.
 */
export function spaModule(env: Env): DynamicModule {
  // src/ or dist/ → apps/api → apps/web/dist
  const rootPath = env.WEB_DIST_DIR ?? resolve(import.meta.dirname, '../../web/dist');
  if (!existsSync(join(rootPath, 'index.html'))) {
    throw new Error(`SPA build not found at ${rootPath}. Run \`pnpm build\` or set WEB_DIST_DIR.`);
  }

  return ServeStaticModule.forRoot({
    rootPath,
    exclude: /^\/api(\/|$)/,
    serveStaticOptions: {
      index: false,
      setHeaders: (res: ServerResponse, filePath: string) => {
        // Vite emits content-hashed files under assets/; index.html must always revalidate.
        const cacheControl = /[\\/]assets[\\/]/.test(filePath)
          ? 'public, max-age=31536000, immutable'
          : basename(filePath) === 'index.html'
            ? 'no-cache'
            : 'public, max-age=3600';
        res.setHeader('Cache-Control', cacheControl);
      },
    },
  });
}
