import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@camex/shared';
import type { Request } from 'express';

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

export type RequestWithAuth = Request & { auth?: AuthContext };

/** The authenticated user + session, set by SessionGuard. Only valid on non-@Public routes. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
  if (!auth) throw new Error('@Auth() used on a route without an authenticated session');
  return auth;
});
