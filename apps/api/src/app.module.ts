import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { EnvModule } from './config/env.module.js';
import type { Env } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { loggerParams } from './logging.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { spaModule } from './spa.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';

@Module({})
export class AppModule {
  /** The validated env is passed in so tests can boot the app with their own config. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        LoggerModule.forRoot(loggerParams(env)),
        PrismaModule,
        StorageModule,
        AuthModule,
        UsersModule,
        ...(env.NODE_ENV === 'production' ? [spaModule(env)] : []),
      ],
      controllers: [HealthController],
    };
  }
}
