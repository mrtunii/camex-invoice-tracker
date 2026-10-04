import { Injectable } from '@nestjs/common';

export const LOGIN_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  maxFailuresPerEmail: 5,
  maxFailuresPerIp: 20,
} as const;

interface Bucket {
  failures: number;
  resetAt: number;
}

/**
 * Counts failed logins per IP and per email in fixed windows. Once either limit is reached,
 * further attempts are refused (before any password hashing) until the window ends.
 *
 * In-memory: correct for the single production container (SPEC §3); resets on restart.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  isBlocked(ip: string, email: string, now = Date.now()): boolean {
    return (
      this.failures(`ip:${ip}`, now) >= LOGIN_RATE_LIMIT.maxFailuresPerIp ||
      this.failures(`email:${email}`, now) >= LOGIN_RATE_LIMIT.maxFailuresPerEmail
    );
  }

  recordFailure(ip: string, email: string, now = Date.now()): void {
    this.increment(`ip:${ip}`, now);
    this.increment(`email:${email}`, now);
    if (this.buckets.size > 10_000) this.sweep(now);
  }

  /** A successful login clears the email's failures (the IP's count stands). */
  recordSuccess(email: string): void {
    this.buckets.delete(`email:${email}`);
  }

  private failures(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket.failures : 0;
  }

  private increment(key: string, now: number): void {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt > now) bucket.failures += 1;
    else this.buckets.set(key, { failures: 1, resetAt: now + LOGIN_RATE_LIMIT.windowMs });
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}
