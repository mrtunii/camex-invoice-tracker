import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { ClockModule } from './clock/clock.module.js';
import { EnvModule } from './config/env.module.js';
import type { Env } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { InboxModule } from './inbox/inbox.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { loggerParams } from './logging.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';
import { VendorsModule } from './vendors/vendors.module.js';

@Module({})
export class AppModule {
  /** The validated env is passed in so tests can boot the app with their own config. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        ClockModule,
        LoggerModule.forRoot(loggerParams(env)),
        PrismaModule,
        StorageModule,
        JobsModule,
        AuthModule,
        UsersModule,
        IngestionModule,
        InboxModule,
        InvoicesModule,
        VendorsModule,
      ],
      controllers: [HealthController],
    };
  }
}
