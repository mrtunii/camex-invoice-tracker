export interface ExtractionInput {
  pdf: Buffer;
  fileName: string;
  /** Context from the email the PDF arrived with (null for manual uploads / missing headers). */
  email: { from: string | null; subject: string | null };
}

export interface ExtractionResult {
  model: string;
  promptVersion: string;
  /** The provider's output as received; stored verbatim in invoices.extraction_raw. */
  raw: unknown;
}

/** SPEC §7. One implementation per provider, chosen by EXTRACTOR_PROVIDER. */
export interface InvoiceExtractor {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export const INVOICE_EXTRACTOR = Symbol('INVOICE_EXTRACTOR');
