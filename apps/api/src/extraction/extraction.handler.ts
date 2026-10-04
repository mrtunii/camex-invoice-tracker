import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ExtractedInvoice } from '@camex/shared';
import { extractedInvoiceColumns } from '../invoices/invoice-columns.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { errorMessage, failExtraction, toJsonColumn } from './extraction-failure.js';
import { extractJobDataSchema } from './extraction-queue.js';
import {
  type ExtractionResult,
  INVOICE_EXTRACTOR,
  type InvoiceExtractor,
  NonRetryableExtractionError,
} from './invoice-extractor.js';
import { normalizeExtraction } from './normalize.js';

/** What the handler needs from a pg-boss job (fetched with includeMetadata). */
export interface ExtractionAttempt {
  data: unknown;
  /** 0 on the first attempt. */
  retryCount: number;
  retryLimit: number;
}

/**
 * Runs one extraction attempt for one invoice (SPEC §7): extract → normalize → store every
 * field → needs_review. Idempotent: an invoice that is no longer `processing` is left alone.
 * (Vendor matching, derived dates and flags come in T04.)
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
        invoiceId,
      });
      await this.storeSuccess(invoiceId, result, normalizeExtraction(result.raw));
      this.logger.log(
        {
          invoiceId,
          attempt,
          model: result.model,
          promptVersion: result.promptVersion,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: result.durationMs,
        },
        'extraction succeeded',
      );
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof NonRetryableExtractionError) {
        // Retrying can't help: fail now and let the job complete, so pg-boss doesn't retry.
        this.logger.warn(
          { invoiceId, attempt, retryable: false, err: message },
          'extraction failed',
        );
        await failExtraction(this.prisma, invoiceId, {
          error: message,
          event: { attempts: attempt, retryable: false },
          output: error.output,
        });
        return;
      }

      // pg-boss counts attempts in retryCount (0-based) and stops retrying once it reaches
      // retryLimit, so this attempt is the last one when they are equal.
      const isFinalAttempt = job.retryCount >= job.retryLimit;
      this.logger.warn(
        { invoiceId, attempt, attempts, final: isFinalAttempt, err: message },
        'extraction attempt failed',
      );
      if (isFinalAttempt) {
        await failExtraction(this.prisma, invoiceId, {
          error: message,
          event: { attempts: attempt },
        });
      }
      throw error;
    }
  }

  private async storeSuccess(
    invoiceId: string,
    result: ExtractionResult,
    extracted: ExtractedInvoice,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Conditional on status so a concurrent run can't apply a second result.
      const { count } = await tx.invoice.updateMany({
        where: { id: invoiceId, status: 'processing' },
        data: {
          ...extractedInvoiceColumns(extracted),
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
          data: {
            model: result.model,
            promptVersion: result.promptVersion,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            durationMs: result.durationMs,
          },
        },
      });
    });
  }
}
