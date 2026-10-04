import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExtractionQueue } from './extraction-queue.js';

/** Invoices still `processing` this long after their last update are considered stuck. */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
const BATCH = 500;

/**
 * Safety net for invoices whose job was lost (enqueue failed after commit, a crash during the
 * final attempt, a job that expired on its last try). Runs every 5 minutes via pg-boss cron.
 * Re-enqueueing is harmless: an invoice with a live job is skipped by the queue policy.
 */
@Injectable()
export class RecoverySweep {
  private readonly logger = new Logger(RecoverySweep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ExtractionQueue,
  ) {}

  /** Returns the ids that got a new extraction job. */
  async run(now = new Date()): Promise<string[]> {
    const stuck = await this.prisma.invoice.findMany({
      where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    if (stuck.length === 0) return [];

    const enqueued = await this.queue.enqueue(stuck.map((invoice) => invoice.id));
    this.logger.log({ stuck: stuck.length, reenqueued: enqueued.length }, 'recovery sweep');
    return enqueued;
  }
}
