import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthUser, ChangePasswordRequest, LoginRequest } from '@camex/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { SessionsService } from './sessions.service.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

export interface LoginResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  async login(
    input: LoginRequest,
    meta: { ip: string; userAgent: string | null },
  ): Promise<LoginResult> {
    if (this.rateLimiter.isBlocked(meta.ip, input.email)) {
      this.logger.warn({ ip: meta.ip }, 'login rate-limited');
      throw new HttpException(
        { statusCode: 429, message: 'Too many login attempts. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const passwordOk = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);

    // One generic answer for unknown email, wrong password and deactivated user.
    if (!user || !passwordOk || !user.isActive) {
      this.rateLimiter.recordFailure(meta.ip, input.email);
      this.logger.warn({ ip: meta.ip }, 'login failed');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    this.rateLimiter.recordSuccess(input.email);
    const { token, expiresAt } = await this.sessions.create(user.id, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.logger.log({ userId: user.id }, 'login succeeded');

    return { user: { id: user.id, email: user.email, name: user.name }, token, expiresAt };
  }

  /** Changes the password and signs out every other session of this user. */
  async changePassword(userId: string, sessionId: string, input: ChangePasswordRequest) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      // 400, not 401: the session is fine, only the confirmation failed.
      throw new BadRequestException('Current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(input.newPassword) },
    });
    await this.sessions.revokeAllForUser(userId, { except: sessionId });
    this.logger.log({ userId }, 'password changed');
  }
}
