import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BUSINESS_TIME_ZONE } from '@camex/shared';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { InvoiceEvaluator } from './invoice-evaluator.js';

export const REEVALUATE_QUEUE = 'invoice.reevaluate';
/** 00:05 every day, in BUSINESS_TIME_ZONE: DISPUTE_SOON and FUTURE_DATE depend on the date. */
export const REEVALUATE_CRON = '5 0 * * *';

/** Registers the daily re-evaluation (unless WORKERS_ENABLED=false). */
@Injectable()
export class EvaluationWorkers implements OnApplicationBootstrap {
  private readonly logger = new Logger(EvaluationWorkers.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly evaluator: InvoiceEvaluator,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.WORKERS_ENABLED) return;
    const boss = await this.jobs.ready();
    await boss.createQueue(REEVALUATE_QUEUE, { policy: 'singleton' });
    await boss.work(REEVALUATE_QUEUE, async () => {
      await this.run();
    });
    // pg-boss evaluates cron in `tz` (UTC by default). `missed: 'once'`: if the app was down at
    // 00:05, the next cron pass still sends the day's run.
    await boss.schedule(REEVALUATE_QUEUE, REEVALUATE_CRON, null, {
      tz: BUSINESS_TIME_ZONE,
      missed: 'once',
    });
  }

  async run(): Promise<void> {
    const result = await this.evaluator.reevaluateOpen();
    this.logger.log(result, 'daily re-evaluation');
  }
}
