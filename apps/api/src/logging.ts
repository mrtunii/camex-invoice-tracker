import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from './config/env.js';

interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
  remoteAddress?: string;
}

interface SerializedResponse {
  statusCode: number;
}

/**
 * pino via nestjs-pino. Request logs carry method/url/status only: no headers (cookies),
 * no bodies (passwords now, bank details and files later).
 */
export function loggerParams(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
      autoLogging: {
        ignore: (req: IncomingMessage) => !req.url?.startsWith('/api') || req.url === '/api/health',
      },
      serializers: {
        req: (req: SerializedRequest) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
