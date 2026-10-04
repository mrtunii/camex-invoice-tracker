import { z } from 'zod';
import { uuidSchema } from './common.js';

/** SPEC §6. `processing` until extraction finishes (successfully or not). */
export const invoiceStatusSchema = z.enum([
  'processing',
  'needs_review',
  'unpaid',
  'paid',
  'rejected',
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const extractionStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;

/** Multipart field name and file count for POST /api/invoices/upload. */
export const UPLOAD_FIELD_NAME = 'files';
export const MAX_UPLOAD_FILES = 20;

/** Result of ingesting one email or one manual upload. */
export const ingestResultSchema = z.object({
  inboundEmailId: uuidSchema,
  invoiceIds: z.array(uuidSchema),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

/** 400 body when an upload contains files that aren't PDFs (nothing is stored). */
export const uploadRejectedSchema = z.object({
  message: z.string(),
  rejectedFiles: z.array(z.string()),
});
export type UploadRejected = z.infer<typeof uploadRejectedSchema>;
