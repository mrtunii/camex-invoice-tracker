import type { InvoiceEvaluator } from '../evaluation/invoice-evaluator.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NonRetryableExtractionError } from './invoice-extractor.js';

export const MAX_ERROR_LENGTH = 1000;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * jsonb-safe copy of provider output: drops undefined/functions and strips NUL characters,
 * which Postgres rejects in jsonb strings.
 */
export function toJsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const json: unknown = JSON.parse(
    JSON.stringify(value ?? null, (_key, v: unknown) =>
      typeof v === 'string' ? v.replaceAll('\u0000', '') : v,
    ),
  );
  return json === null ? Prisma.JsonNull : (json as Prisma.InputJsonValue);
}

export interface ExtractionFailure {
  error: string;
  /** `extraction_failed` event data (the error is added). */
  event: Record<string, Prisma.InputJsonValue>;
  /** What the provider returned before failing, kept for review. */
  output?: NonRetryableExtractionError['output'];
  /** Only fail it if the row has not changed since this time (recovery sweep). */
  unchangedSince?: Date;
}

/**
 * The final-failure path (SPEC §7): extraction_status=failed, the error, status=needs_review so
 * a human can enter the data, an `extraction_failed` event, and the evaluation (vendor, dates,
 * flags), in one transaction: a `needs_review` invoice never exists without its flags. If the
 * evaluation throws, nothing is written and the error propagates. Applies only while the invoice
 * is still `processing`; returns whether it did.
 */
export async function failExtraction(
  prisma: PrismaService,
  evaluator: InvoiceEvaluator,
  invoiceId: string,
  failure: ExtractionFailure,
): Promise<boolean> {
  const error = failure.error.slice(0, MAX_ERROR_LENGTH);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        status: 'processing',
        ...(failure.unchangedSince ? { updatedAt: { lt: failure.unchangedSince } } : {}),
      },
      data: {
        extractionStatus: 'failed',
        extractionError: error,
        status: 'needs_review',
        ...(failure.output
          ? {
              extractionRaw: toJsonColumn(failure.output.raw),
              extractionModel: failure.output.model,
              extractionPromptVersion: failure.output.promptVersion,
            }
          : {}),
      },
    });
    if (count === 0) return false;
    await tx.invoiceEvent.create({
      data: { invoiceId, type: 'extraction_failed', data: { error, ...failure.event } },
    });
    await evaluator.evaluate(tx, invoiceId, evaluator.today());
    return true;
  });
}
