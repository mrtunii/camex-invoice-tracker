import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { type Request, type RequestHandler, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';
import { MB, webhookParserErrors, webhookRequestLimit } from './ingestion/webhook-limits.js';

export const MAILGUN_WEBHOOK_PATH = '/api/inbound/mailgun';

/** Machine-to-machine webhooks: no browser calls them, so no CORS and no Origin check. */
const INBOUND_PREFIX = '/api/inbound/';

/** Express routes ignore case, so the inbound exemption must too. */
function isInbound(req: Request): boolean {
  return req.path.toLowerCase().startsWith(INBOUND_PREFIX);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (SessionGuard + SameSite=Lax are the first line): a state-changing
 * request carrying an Origin outside WEB_ORIGINS gets 403 before anything reads its body.
 * Requests without an Origin (curl, scripts, the CLIs) pass: browsers always send one on
 * cross-origin POST, PATCH and DELETE.
 */
function originCheck(allowedOrigins: readonly string[]): RequestHandler {
  return function originCheck(req, res, next) {
    const { origin } = req.headers;
    if (
      origin === undefined ||
      SAFE_METHODS.has(req.method) ||
      allowedOrigins.includes(origin) ||
      isInbound(req)
    ) {
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, error: 'Forbidden', message: 'Origin not allowed' });
  };
}

/**
 * Mailgun posts x-www-form-urlencoded when an email has no attachments; its text parts can exceed
 * the default 100 kB body limit (SPEC §4: ≥ 30 MB). Scoped to the webhook so every other route
 * keeps the defaults. (Named so Nest doesn't mistake it for its own global urlencoded parser.)
 */
function mailgunFormParser(maxBytes: number): RequestHandler {
  const parse = urlencoded({ extended: false, limit: maxBytes });
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
  // The web app is served from its own origin (WEB_ORIGINS) and calls the API with credentials.
  // Any other origin, and every /api/inbound/* request, gets no CORS headers at all.
  app.enableCors((req: Request, callback) => {
    const { origin } = req.headers;
    const allowed = origin !== undefined && env.WEB_ORIGINS.includes(origin) && !isInbound(req);
    callback(
      null,
      allowed
        ? {
            origin,
            credentials: true,
            methods: ['GET', 'POST', 'PATCH', 'DELETE'],
            allowedHeaders: ['Content-Type'],
            maxAge: 600,
          }
        : { origin: false },
    );
  });
  app.use(originCheck(env.WEB_ORIGINS));
  app.use(cookieParser());
  // Size cap first, before anything reads the body; then the urlencoded parser, whose own limit
  // errors also become 406 (multipart is parsed later, by MailgunFilesInterceptor).
  const maxRequestBytes = env.INBOUND_MAX_REQUEST_MB * MB;
  app.use(
    MAILGUN_WEBHOOK_PATH,
    webhookRequestLimit(maxRequestBytes),
    mailgunFormParser(maxRequestBytes),
    webhookParserErrors(),
  );
  app.enableShutdownHooks();
}
