import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';

export const SESSION_COOKIE = 'camex_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** last_seen_at / expires_at are written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Opaque 32-byte random token; only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(secure), expires: expiresAt });
}

export function clearSessionCookie(res: Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
