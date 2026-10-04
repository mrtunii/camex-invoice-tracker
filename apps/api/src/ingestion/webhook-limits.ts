import { Logger } from '@nestjs/common';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Options as MulterOptions } from 'multer';
import type { Env } from '../config/env.js';

// Mailgun retries every answer except 200 and 406 for about 8 hours. A message that breaks a
// limit will break it again, so every limit violation on the webhook is answered 406.
// (Manual upload keeps 413/400: a person sees those.)

export const MB = 1024 * 1024;

const logger = new Logger('MailgunWebhook');

/** Limits for inbound multipart bodies (Mailgun and manual upload). */
export function inboundMulterOptions(env: Env) {
  return {
    limits: {
      fileSize: env.INBOUND_MAX_FILE_MB * MB,
      files: env.INBOUND_MAX_FILES,
      // Text fields (body-plain, body-html, message-headers, …) and their count.
      fieldSize: 10 * MB,
      fields: 500,
    },
    // Attachment names are UTF-8 in practice (multer's default is latin1).
    defParamCharset: 'utf8',
  } satisfies MulterOptions;
}

/** Error level, with what is known about the request; never anything from the body. */
export function logWebhookLimit(req: Request, limit: string): void {
  logger.error(
    { contentLength: req.headers['content-length'] ?? null, ip: req.ip ?? null, limit },
    'mailgun webhook rejected: limit exceeded',
  );
}

/** Logs, answers 406 and closes the connection, so the rest of the body is never read. */
export function rejectWebhook(req: Request, res: Response, limit: string): void {
  logWebhookLimit(req, limit);
  if (res.headersSent) return;
  res.setHeader('Connection', 'close');
  res.status(406).json({
    statusCode: 406,
    message: 'Message exceeds the inbound limits',
    error: 'Not Acceptable',
  });
}

/**
 * INBOUND_MAX_REQUEST_MB for the webhook, before any body parser. A declared Content-Length
 * over the cap is rejected without reading; otherwise the bytes are counted as they stream in
 * (chunked bodies have no Content-Length), and the request is rejected once they pass the cap.
 */
export function webhookRequestLimit(maxBytes: number): RequestHandler {
  return function webhookRequestLimit(req, res, next) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      rejectWebhook(req, res, 'INBOUND_MAX_REQUEST_MB');
      return;
    }

    // Count at the stream's emit, so whichever parser reads the body later sees the same data
    // (a 'data' listener here would switch the stream to flowing before the parser attaches).
    // After a rejection the parser gets nothing more, not even 'end', so it can't complete
    // the request; it gives up when the connection closes.
    const emit = req.emit.bind(req);
    let received = 0;
    let rejected = false;
    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (rejected && (event === 'data' || event === 'end')) return false;
      if (event === 'data') {
        const chunk = args[0];
        if (Buffer.isBuffer(chunk)) received += chunk.length;
        else if (typeof chunk === 'string') received += Buffer.byteLength(chunk);
        if (received > maxBytes) {
          rejected = true;
          rejectWebhook(req, res, 'INBOUND_MAX_REQUEST_MB');
          return false;
        }
      }
      return emit(event, ...args);
    }) as typeof req.emit;
    next();
  };
}

/** body-parser limits on the webhook's urlencoded parser (no attachments) → 406. */
export function webhookParserErrors(): ErrorRequestHandler {
  return function webhookParserErrors(error: unknown, req, res, next) {
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : null;
    if (type === 'entity.too.large') {
      rejectWebhook(req, res, 'INBOUND_MAX_REQUEST_MB');
      return;
    }
    if (type === 'parameters.too.many') {
      rejectWebhook(req, res, 'field count');
      return;
    }
    next(error);
  };
}

/** multer codes for size/count limits (LIMIT_UNEXPECTED_FILE is a field-name mismatch). */
export function isMulterLimit(code: string): boolean {
  return code.startsWith('LIMIT_') && code !== 'LIMIT_UNEXPECTED_FILE';
}

/** multer limit code → the setting that was hit. */
export function multerLimitName(code: string): string {
  switch (code) {
    case 'LIMIT_FILE_SIZE':
      return 'INBOUND_MAX_FILE_MB';
    case 'LIMIT_FILE_COUNT':
      return 'INBOUND_MAX_FILES';
    case 'LIMIT_FIELD_VALUE':
      return 'field size';
    case 'LIMIT_FIELD_COUNT':
      return 'field count';
    case 'LIMIT_FIELD_KEY':
      return 'field name size';
    case 'LIMIT_PART_COUNT':
      return 'part count';
    default:
      return code;
  }
}
