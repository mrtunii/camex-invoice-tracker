import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { type RequestHandler, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

export const MAILGUN_WEBHOOK_PATH = '/api/inbound/mailgun';

/**
 * Mailgun posts x-www-form-urlencoded when an email has no attachments; its text parts can exceed
 * the default 100 kB body limit (SPEC §4: ≥ 30 MB). Scoped to the webhook so every other route
 * keeps the defaults. (Named so Nest doesn't mistake it for its own global urlencoded parser.)
 */
function mailgunFormParser(): RequestHandler {
  const parse = urlencoded({ extended: false, limit: '30mb' });
  return function mailgunFormParser(req, res, next) {
    parse(req, res, next);
  };
}

/** HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.set('trust proxy', env.TRUST_PROXY > 0 ? env.TRUST_PROXY : false);
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.use(MAILGUN_WEBHOOK_PATH, mailgunFormParser());
  app.enableShutdownHooks();
}
