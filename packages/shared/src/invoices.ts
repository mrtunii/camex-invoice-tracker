import { z } from 'zod';
import { isoTimestampSchema, namedRefSchema, uuidSchema } from './common.js';
import {
  bankDetailsSchema,
  calendarDateSchema,
  currencyCodeSchema,
  decimalStringSchema,
  documentTypeSchema,
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

/**
 * GET /api/invoices/:id. Decimals are strings, calendar dates 'YYYY-MM-DD'. The raw model
 * output is not exposed. (T06 adds workflow fields, the source email and the activity log.)
 */
export const invoiceDetailSchema = z.object({
  id: uuidSchema,
  inboundEmailId: uuidSchema,
  fileName: z.string(),
  fileSize: z.number().int().nonnegative(),
  fileSha256: z.string(),
  pageCount: z.number().int().nullable(),
  status: invoiceStatusSchema,

  extractionStatus: extractionStatusSchema,
  extractionError: z.string().nullable(),
  extractionModel: z.string().nullable(),
  extractionPromptVersion: z.string().nullable(),
  extractedAt: isoTimestampSchema.nullable(),

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

  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
