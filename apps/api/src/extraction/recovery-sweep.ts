import { Injectable, Logger } from '@nestjs/common';
import { InvoiceEvaluator } from '../evaluation/invoice-evaluator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { failExtraction } from './extraction-failure.js';
import { ExtractionQueue } from './extraction-queue.js';

/** Invoices still `processing` this long after their last update are considered stuck. */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
/** ...and past this, given up on: a human enters the data instead. */
export const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
export const GIVE_UP_ERROR = 'Extraction did not finish within 60 minutes';
const BATCH = 500;

export interface SweepResult {
  /** Stuck 10–60 minutes: got a new extraction job. */
  reenqueued: string[];
  /** Stuck over 60 minutes: failed (needs_review, extraction_failed). */
  failed: string[];
}

/**
 * Safety net for invoices whose job was lost (enqueue failed after commit, a crash during the
 * final attempt, a job that expired on its last try). Runs every 5 minutes via pg-boss cron.
 * Re-enqueueing is harmless: an invoice with a live job is skipped by the queue policy. After an
 * hour it stops trying, so a document that always hangs can't loop forever.
 */
@Injectable()
export class RecoverySweep {
  private readonly logger = new Logger(RecoverySweep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ExtractionQueue,
    private readonly evaluator: InvoiceEvaluator,
  ) {}

  async run(now = new Date()): Promise<SweepResult> {
    const giveUpBefore = new Date(now.getTime() - GIVE_UP_AFTER_MS);
    const expired = await this.stuckSince(giveUpBefore);
    const failed: string[] = [];
    for (const id of expired) {
      try {
        const applied = await failExtraction(this.prisma, this.evaluator, id, {
          error: GIVE_UP_ERROR,
          event: { retryable: false },
          unchangedSince: giveUpBefore,
        });
        if (applied) {
          failed.push(id);
          await this.evaluator.tryEvaluateWithRelated(id);
        }
      } catch (error) {
        // Nothing was written (the evaluation runs in the same transaction): the next sweep
        // tries again, and one invoice can't hold up the others.
        this.logger.error(
          { invoiceId: id, err: error instanceof Error ? error.message : String(error) },
          'giving up on extraction failed',
        );
      }
    }

    // The expired ones are no longer processing, so this is the 10–60 minute window.
    const stuck = await this.stuckSince(new Date(now.getTime() - STUCK_AFTER_MS));
    const reenqueued = stuck.length > 0 ? await this.queue.enqueue(stuck) : [];

    if (expired.length > 0 || stuck.length > 0) {
      this.logger.log(
        { stuck: stuck.length, reenqueued: reenqueued.length, failed: failed.length },
        'recovery sweep',
      );
    }
    return { reenqueued, failed };
  }

  private async stuckSince(cutoff: Date): Promise<string[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { status: 'processing', updatedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    return rows.map((row) => row.id);
  }
}
