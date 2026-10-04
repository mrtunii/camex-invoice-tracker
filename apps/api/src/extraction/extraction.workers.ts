import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { ExtractionHandler } from './extraction.handler.js';
import { EXTRACT_QUEUE, ExtractionQueue, RECOVER_QUEUE } from './extraction-queue.js';
import { RecoverySweep } from './recovery-sweep.js';

const EXTRACT_CONCURRENCY = 2;
const RECOVERY_CRON = '*/5 * * * *';

/** Registers the in-process workers (unless WORKERS_ENABLED=false) before the app listens. */
@Injectable()
export class ExtractionWorkers implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExtractionWorkers.name);

  constructor(
    private readonly queue: ExtractionQueue,
    private readonly handler: ExtractionHandler,
    private readonly sweep: RecoverySweep,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const boss = await this.queue.ready();
    if (!this.env.WORKERS_ENABLED) {
      this.logger.warn('job workers disabled (WORKERS_ENABLED=false)');
      return;
    }

    await boss.work(
      EXTRACT_QUEUE,
      { localConcurrency: EXTRACT_CONCURRENCY, includeMetadata: true },
      async ([job]) => {
        if (job) await this.handler.handle(job);
      },
    );
    await boss.work(RECOVER_QUEUE, async () => {
      await this.sweep.run();
    });
    await boss.schedule(RECOVER_QUEUE, RECOVERY_CRON);
  }
}
