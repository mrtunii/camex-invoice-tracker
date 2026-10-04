import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PASSWORD_CHANGE_REQUIRED } from '@camex/shared';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import type { RequestWithAuth } from './auth-context.js';
import { ALLOW_DURING_PASSWORD_CHANGE, IS_PUBLIC } from './public.decorator.js';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-token.js';
import { SessionsService } from './sessions.service.js';

/**
 * Global guard: every route needs a valid session unless marked @Public(). A user who must
 * change their password only gets the routes marked @AllowDuringPasswordChange().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithAuth>();
    const res = http.getResponse<Response>();
    const secure = this.env.NODE_ENV === 'production';

    const token = readSessionCookie(req);
    const session = token ? await this.sessions.validate(token) : null;
    if (!token || !session) {
      if (token) clearSessionCookie(res, secure);
      throw new UnauthorizedException('Not authenticated');
    }

    if (session.extendedUntil) setSessionCookie(res, token, session.extendedUntil, secure);
    req.auth = { user: session.user, sessionId: session.sessionId };

    if (session.user.mustChangePassword && !this.allowsPendingPasswordChange(context)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: PASSWORD_CHANGE_REQUIRED,
        message: 'Set a new password to continue',
      });
    }
    return true;
  }

  private allowsPendingPasswordChange(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_DURING_PASSWORD_CHANGE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
