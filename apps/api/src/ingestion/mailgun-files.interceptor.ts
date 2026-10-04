import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  NotAcceptableException,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import {
  inboundMulterOptions,
  isMulterLimit,
  logWebhookLimit,
  multerLimitName,
} from './webhook-limits.js';

/** busboy's messages for a malformed body (the ones Nest also answers with 400). */
const MALFORMED_MULTIPART = new Set([
  'Multipart: Boundary not found',
  'Malformed part header',
  'Unexpected end of form',
  'Unexpected end of file',
]);

/**
 * AnyFilesInterceptor for the webhook, except that limit violations become 406: Nest maps them
 * to 413/400, which Mailgun keeps retrying. Malformed bodies stay 400, anything else 500.
 * (multer drains the rest of the body before reporting, bounded by INBOUND_MAX_REQUEST_MB.)
 */
@Injectable()
export class MailgunFilesInterceptor implements NestInterceptor {
  private readonly parse: RequestHandler;

  constructor(@Inject(ENV) env: Env) {
    this.parse = multer(inboundMulterOptions(env)).any();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    await new Promise<void>((resolve, reject) => {
      void this.parse(req, http.getResponse<Response>(), (error: unknown) => {
        if (error === undefined || error === null) {
          resolve();
        } else if (error instanceof multer.MulterError && isMulterLimit(error.code)) {
          logWebhookLimit(req, multerLimitName(error.code));
          reject(new NotAcceptableException('Message exceeds the inbound limits'));
        } else if (error instanceof multer.MulterError) {
          reject(new BadRequestException(error.message));
        } else if (error instanceof Error && MALFORMED_MULTIPART.has(error.message)) {
          reject(new BadRequestException(`Multipart: ${error.message}`));
        } else {
          reject(error instanceof Error ? error : new Error('Multipart parsing failed'));
        }
      });
    });
    return next.handle();
  }
}
