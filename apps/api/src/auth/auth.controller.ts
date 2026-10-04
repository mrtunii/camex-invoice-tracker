import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type AuthResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  changePasswordRequestSchema,
  loginRequestSchema,
} from '@camex/shared';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { Auth, type AuthContext } from './auth-context.js';
import { AuthService } from './auth.service.js';
import { AllowDuringPasswordChange, Public } from './public.decorator.js';
import { clearSessionCookie, setSessionCookie } from './session-token.js';
import { SessionsService } from './sessions.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get secureCookies(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { user, token, expiresAt } = await this.auth.login(body, {
      ip: req.ip ?? 'unknown',
      userAgent: req.get('user-agent') ?? null,
    });
    setSessionCookie(res, token, expiresAt, this.secureCookies);
    return { user };
  }

  @AllowDuringPasswordChange()
  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId);
    clearSessionCookie(res, this.secureCookies);
  }

  @AllowDuringPasswordChange()
  @Get('me')
  me(@Auth() auth: AuthContext): AuthResponse {
    return { user: auth.user };
  }

  @AllowDuringPasswordChange()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
  ) {
    await this.auth.changePassword(auth.user.id, auth.sessionId, body);
  }
}
