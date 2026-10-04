import { z } from 'zod';
import { isoTimestampSchema, namedRefSchema, uuidSchema } from './common.js';
import {
  bankDetailsSchema,
  calendarDateSchema,
  currencyCodeSchema,
  decimalStringSchema,
  documentTypeSchema,
  extractedInvoiceSchema,
  extractedLineItemSchema,
  invoiceCategorySchema,
} from './extraction.js';

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

/** How invoices.due_date was set (SPEC §5, §7). Printed and manual dates are never re-derived. */
export const dueDateSourceSchema = z.enum(['printed', 'terms', 'vendor_default', 'manual']);
export type DueDateSource = z.infer<typeof dueDateSourceSchema>;

/** SPEC §5 invoices.rejection_reason. */
export const rejectionReasonSchema = z.enum(['duplicate', 'not_invoice', 'disputed', 'other']);
export type RejectionReason = z.infer<typeof rejectionReasonSchema>;

/** SPEC §5 invoice_events.type. */
export const invoiceEventTypeSchema = z.enum([
  'received',
  'extracted',
  'extraction_failed',
  'edited',
  'approved',
  'rejected',
  'paid',
  'payment_undone',
  'reopened',
  'reextracted',
  'vendor_linked',
  'bank_account_trusted',
]);
export type InvoiceEventType = z.infer<typeof invoiceEventTypeSchema>;

/** SPEC §8 flag codes, in table order. */
export const flagCodeSchema = z.enum([
  'EXTRACTION_FAILED',
  'MISSING_REQUIRED',
  'TOTAL_MATH',
  'LINE_MATH',
  'DUE_BEFORE_INVOICE',
  'TERMS_MISMATCH',
  'DUE_DATE_DERIVED',
  'FUTURE_DATE',
  'SERVICE_AFTER_INVOICE',
  'PAY_IN_OTHER_CURRENCY',
  'NOT_BILLED_TO_CAMEX',
  'NOT_AN_INVOICE',
  'DUPLICATE_FILE',
  'DUPLICATE_NUMBER',
  'NEW_VENDOR',
  'BANK_FIRST_SEEN',
  'BANK_UNKNOWN',
  'DISPUTE_SOON',
]);
export type FlagCode = z.infer<typeof flagCodeSchema>;

export const flagSeveritySchema = z.enum(['error', 'warning', 'info']);
export type FlagSeverity = z.infer<typeof flagSeveritySchema>;

/**
 * SPEC §5 flags, recomputed by the server. `field` is the camelCase path of the field the flag is
 * about (`dueDate`, `lineItems.1.amount`, `bankDetails.iban`), or null. Messages are plain English
 * and never contain bank account numbers.
 */
export const invoiceFlagSchema = z.object({
  code: flagCodeSchema,
  severity: flagSeveritySchema,
  field: z.string().nullable(),
  message: z.string(),
});
export type InvoiceFlag = z.infer<typeof invoiceFlagSchema>;

/** The email (or manual upload) that carried the PDF; its body comes from GET /api/inbox/:id. */
export const invoiceSourceEmailSchema = z.object({
  id: uuidSchema,
  provider: z.enum(['mailgun', 'manual']),
  fromAddress: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: isoTimestampSchema,
  /** Who uploaded it (manual uploads only). */
  uploadedBy: namedRefSchema.nullable(),
  /** Attachments that weren't PDFs: recorded, not stored. */
  ignoredAttachments: z.array(
    z.object({ filename: z.string(), contentType: z.string(), size: z.number().int() }),
  ),
});
export type InvoiceSourceEmail = z.infer<typeof invoiceSourceEmailSchema>;

/**
 * GET /api/invoices/:id. Decimals are strings, calendar dates 'YYYY-MM-DD'. The raw model output
 * is not exposed; `extracted` is its normalized reading.
 */
export const invoiceDetailSchema = z.object({
  id: uuidSchema,
  inboundEmailId: uuidSchema,
  fileName: z.string(),
  fileSize: z.number().int().nonnegative(),
  fileSha256: z.string(),
  pageCount: z.number().int().nullable(),
  status: invoiceStatusSchema,
  /**
   * Optimistic concurrency (T06): every human write (an edit or a transition) carries the version
   * it was made against and increments it; a mismatch is 409 STALE. The evaluator and the
   * extraction worker don't change it.
   */
  version: z.number().int().nonnegative(),

  extractionStatus: extractionStatusSchema,
  extractionError: z.string().nullable(),
  extractionModel: z.string().nullable(),
  extractionPromptVersion: z.string().nullable(),
  extractedAt: isoTimestampSchema.nullable(),
  /**
   * The model's reading, normalized (normalizeExtraction of the raw output): what the fields were
   * before anyone edited them. Null unless the extraction succeeded.
   */
  extracted: extractedInvoiceSchema.nullable(),

  documentType: documentTypeSchema.nullable(),
  vendorId: uuidSchema.nullable(),
  /** The linked vendor (SPEC §9), or null: NEW_VENDOR. */
  vendor: namedRefSchema.nullable(),
  vendorName: z.string().nullable(),
  vendorTaxId: z.string().nullable(),
  billToName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: calendarDateSchema.nullable(),
  serviceDate: calendarDateSchema.nullable(),
  dueDate: calendarDateSchema.nullable(),
  dueDateSource: dueDateSourceSchema.nullable(),
  /** invoice_date + dispute_window_days; always derived. */
  disputeDeadline: calendarDateSchema.nullable(),
  paymentTermsText: z.string().nullable(),
  paymentTermsDays: z.number().int().nullable(),
  disputeWindowDays: z.number().int().nullable(),
  category: invoiceCategorySchema.nullable(),
  description: z.string().nullable(),
  airportIcao: z.string().nullable(),
  airportIata: z.string().nullable(),
  locationText: z.string().nullable(),
  aircraftRegistration: z.string().nullable(),
  flightNumbers: z.array(z.string()),
  currency: currencyCodeSchema.nullable(),
  subtotalAmount: decimalStringSchema.nullable(),
  taxAmount: decimalStringSchema.nullable(),
  totalAmount: decimalStringSchema.nullable(),
  amountDue: decimalStringSchema.nullable(),
  amountDueCurrency: currencyCodeSchema.nullable(),
  lineItems: z.array(extractedLineItemSchema),
  bankDetails: bankDetailsSchema.nullable(),
  notes: z.string().nullable(),
  flags: z.array(invoiceFlagSchema),

  // Workflow (SPEC §6). Cleared again by Reopen and Undo payment; the history is in the events.
  approvedAt: isoTimestampSchema.nullable(),
  approvedBy: namedRefSchema.nullable(),
  paidAt: calendarDateSchema.nullable(),
  paidBy: namedRefSchema.nullable(),
  paymentReference: z.string().nullable(),
  paymentNote: z.string().nullable(),
  rejectedAt: isoTimestampSchema.nullable(),
  rejectedBy: namedRefSchema.nullable(),
  rejectionReason: rejectionReasonSchema.nullable(),
  rejectionNote: z.string().nullable(),

  email: invoiceSourceEmailSchema,

  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
