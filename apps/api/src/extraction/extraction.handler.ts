import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { extractJobDataSchema } from './extraction-queue.js';
import {
  type ExtractionResult,
  INVOICE_EXTRACTOR,
  type InvoiceExtractor,
} from './invoice-extractor.js';

/** What the handler needs from a pg-boss job (fetched with includeMetadata). */
export interface ExtractionAttempt {
  data: unknown;
  /** 0 on the first attempt. */
  retryCount: number;
  retryLimit: number;
}

const MAX_ERROR_LENGTH = 1000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * jsonb-safe copy of provider output: drops undefined/functions and strips NUL characters,
 * which Postgres rejects in jsonb strings.
 */
function toJsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const json: unknown = JSON.parse(
    JSON.stringify(value ?? null, (_key, v: unknown) =>
      typeof v === 'string' ? v.replaceAll('\u0000', '') : v,
    ),
  );
  return json === null ? Prisma.JsonNull : (json as Prisma.InputJsonValue);
}

/**
 * Runs one extraction attempt for one invoice (SPEC §7, T02: storage of the raw result only;
 * T03 adds mapping). Idempotent: an invoice that is no longer `processing` is left alone.
 */
@Injectable()
export class ExtractionHandler {
  private readonly logger = new Logger(ExtractionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(INVOICE_EXTRACTOR) private readonly extractor: InvoiceExtractor,
  ) {}

  async handle(job: ExtractionAttempt): Promise<void> {
    const { invoiceId } = extractJobDataSchema.parse(job.data);
    const attempt = job.retryCount + 1;
    const attempts = job.retryLimit + 1;

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        status: true,
        fileKey: true,
        fileName: true,
        inboundEmail: { select: { fromAddress: true, subject: true } },
      },
    });
    if (invoice?.status !== 'processing') {
      this.logger.debug({ invoiceId, status: invoice?.status ?? null }, 'extraction skipped');
      return;
    }

    try {
      const pdf = await buffer(await this.storage.getStream(invoice.fileKey));
      const result = await this.extractor.extract({
        pdf,
        fileName: invoice.fileName,
        email: { from: invoice.inboundEmail.fromAddress, subject: invoice.inboundEmail.subject },
      });
      await this.storeSuccess(invoiceId, result);
      this.logger.log(
        { invoiceId, attempt, model: result.model, promptVersion: result.promptVersion },
        'extraction succeeded',
      );
    } catch (error) {
      // pg-boss counts attempts in retryCount (0-based) and stops retrying once it reaches
      // retryLimit, so this attempt is the last one when they are equal.
      const isFinalAttempt = job.retryCount >= job.retryLimit;
      const message = errorMessage(error);
      this.logger.warn(
        { invoiceId, attempt, attempts, final: isFinalAttempt, err: message },
        'extraction attempt failed',
      );
      if (isFinalAttempt) await this.storeFailure(invoiceId, message, attempt);
      throw error;
    }
  }

  private async storeSuccess(invoiceId: string, result: ExtractionResult): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Conditional on status so a concurrent run can't apply a second result.
      const { count } = await tx.invoice.updateMany({
        where: { id: invoiceId, status: 'processing' },
        data: {
          extractionRaw: toJsonColumn(result.raw),
          extractionModel: result.model,
          extractionPromptVersion: result.promptVersion,
          extractedAt: new Date(),
          extractionStatus: 'succeeded',
          extractionError: null,
          status: 'needs_review',
        },
      });
      if (count === 0) return;
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: 'extracted',
          data: { model: result.model, promptVersion: result.promptVersion },
        },
      });
    });
  }

  /** After the last attempt: a human enters the data instead (SPEC §7 failures). */
  private async storeFailure(invoiceId: string, message: string, attempts: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: invoiceId, status: 'processing' },
        data: { extractionStatus: 'failed', extractionError: message, status: 'needs_review' },
      });
      if (count === 0) return;
      await tx.invoiceEvent.create({
        data: { invoiceId, type: 'extraction_failed', data: { error: message, attempts } },
      });
    });
  }
}
