import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@camex/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
} from './session-token.js';

export interface ValidatedSession {
  sessionId: string;
  user: AuthUser;
  /** Set when the session was just extended; the cookie must be re-issued with this expiry. */
  extendedUntil: Date | null;
}

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        lastSeenAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    return { token, expiresAt };
  }

  /** Resolves a cookie token to an active session, extending it (at most hourly) on use. */
  async validate(token: string, now = new Date()): Promise<ValidatedSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: {
        user: {
          select: { id: true, email: true, name: true, isActive: true, mustChangePassword: true },
        },
      },
    });
    if (!session) return null;

    if (session.expiresAt <= now || !session.user.isActive) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    let extendedUntil: Date | null = null;
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      extendedUntil = new Date(now.getTime() + SESSION_TTL_MS);
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt: extendedUntil },
      });
    }

    const { id, email, name, mustChangePassword } = session.user;
    return { sessionId: session.id, user: { id, email, name, mustChangePassword }, extendedUntil };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async revokeAllForUser(userId: string, options: { except?: string } = {}): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({
      where: { userId, ...(options.except ? { id: { not: options.except } } : {}) },
    });
    return count;
  }
}
