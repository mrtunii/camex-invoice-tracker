import { Inject, Injectable } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { JobsService } from '../jobs/jobs.service.js';

export const EXTRACT_QUEUE = 'invoice.extract';
export const RECOVER_QUEUE = 'invoice.recover';

/** 3 attempts in total. */
export const EXTRACT_RETRY_LIMIT = 2;
/**
 * An attempt still running after this long is treated as failed (and retried). Below the
 * recovery sweep's 10-minute threshold, so a hung attempt is retried before it is swept.
 */
const EXTRACT_EXPIRE_SECONDS = 5 * 60;

export const extractJobDataSchema = z.object({ invoiceId: z.uuid() });
export type ExtractJobData = z.infer<typeof extractJobDataSchema>;

@Injectable()
export class ExtractionQueue {
  private queuesReady: Promise<PgBoss> | undefined;

  constructor(
    private readonly jobs: JobsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get retryOptions() {
    return {
      retryLimit: EXTRACT_RETRY_LIMIT,
      retryDelay: this.env.EXTRACTION_RETRY_DELAY_SECONDS,
      retryBackoff: true,
      expireInSeconds: EXTRACT_EXPIRE_SECONDS,
    };
  }

  /** The started pg-boss instance with both queues created (idempotent). */
  ready(): Promise<PgBoss> {
    this.queuesReady ??= (async () => {
      const boss = await this.jobs.ready();
      // `exclusive`: at most one queued/retrying/active job per singletonKey (= invoice id), so
      // enqueueing an invoice that already has a live job is a no-op.
      await boss.createQueue(EXTRACT_QUEUE, { policy: 'exclusive', ...this.retryOptions });
      await boss.createQueue(RECOVER_QUEUE, { policy: 'singleton' });
      return boss;
    })();
    return this.queuesReady;
  }

  /**
   * Enqueues one extraction job per invoice. Returns the ids that got a new job (an invoice
   * whose job is still queued, retrying or running is skipped). Retry settings are passed per
   * job so config changes apply even though the queue row already exists.
   */
  async enqueue(invoiceIds: readonly string[]): Promise<string[]> {
    const boss = await this.ready();
    const enqueued: string[] = [];
    for (const invoiceId of invoiceIds) {
      const data: ExtractJobData = { invoiceId };
      const jobId = await boss.send(EXTRACT_QUEUE, data, {
        singletonKey: invoiceId,
        ...this.retryOptions,
      });
      if (jobId !== null) enqueued.push(invoiceId);
    }
    return enqueued;
  }
}
