import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  // Last shutdown phase: job workers stop (beforeApplicationShutdown) and the HTTP server closes
  // before this, so in-flight work can still reach the database.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
