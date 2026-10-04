import type { ExtractionOutputV1 } from '@camex/shared';

export interface ExtractionInput {
  pdf: Buffer;
  fileName: string;
  /** Context from the email the PDF arrived with (null for manual uploads / missing headers). */
  email: { from: string | null; subject: string | null };
  /** For log lines only (null outside the worker, e.g. in the eval). */
  invoiceId: string | null;
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionResult {
  /** The model id the provider reports having used. */
  model: string;
  promptVersion: string;
  /** The validated wire output; stored verbatim in invoices.extraction_raw. */
  raw: ExtractionOutputV1;
  /** Summed over every provider call of this extraction (a re-ask makes two). */
  usage: ExtractionUsage;
  durationMs: number;
}

/** SPEC §7. One implementation per provider, chosen by EXTRACTOR_PROVIDER. */
export interface InvoiceExtractor {
  /**
   * Throws NonRetryableExtractionError when trying again can't help (refusal, output cut off
   * at max_tokens, output still invalid after the re-ask). Any other error is transient and
   * the job is retried.
   */
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export const INVOICE_EXTRACTOR = Symbol('INVOICE_EXTRACTOR');

/** The same input would fail the same way: fail the extraction now instead of retrying. */
export class NonRetryableExtractionError extends Error {
  override readonly name = 'NonRetryableExtractionError';

  constructor(
    message: string,
    /** What the provider returned, if anything (kept in extraction_raw for review). */
    readonly output: { raw: unknown; model: string; promptVersion: string } | null = null,
  ) {
    super(message);
  }
}
