import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/** HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.set('trust proxy', env.TRUST_PROXY > 0 ? env.TRUST_PROXY : false);
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.enableShutdownHooks();
}
