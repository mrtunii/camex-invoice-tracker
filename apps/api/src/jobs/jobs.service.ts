import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';

/** How long a graceful shutdown waits for running jobs before failing them. */
const STOP_TIMEOUT_MS = 20_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pg-boss instance (Postgres-backed job queue, schema `pgboss` in the app database).
 * Started with the app; stopped gracefully on shutdown before the database pools close.
 */
@Injectable()
export class JobsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly boss: PgBoss;
  private starting: Promise<PgBoss> | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      application_name: 'camex-jobs',
      max: 5,
    });
    // pg-boss emits 'error' for background failures (e.g. a lost connection); unhandled it would
    // crash the process. Messages only: job payloads never reach the log.
    this.boss.on('error', (error: unknown) => {
      this.logger.error({ err: messageOf(error) }, 'pg-boss error');
    });
    this.boss.on('warning', (warning: { message: string }) => {
      this.logger.warn({ warning: warning.message }, 'pg-boss warning');
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  /** The started instance. Safe to call from any lifecycle hook, in any order. */
  ready(): Promise<PgBoss> {
    this.starting ??= this.boss.start();
    return this.starting;
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.starting) return;
    await this.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }
}
