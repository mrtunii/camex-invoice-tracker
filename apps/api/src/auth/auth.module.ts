import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BootstrapAdminService } from './bootstrap-admin.service.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { SessionGuard } from './session.guard.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    LoginRateLimiter,
    BootstrapAdminService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [SessionsService],
})
export class AuthModule {}
