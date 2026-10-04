import { z } from 'zod';
import { isoTimestampSchema, namedRefSchema, uuidSchema } from './common.js';
import {
  calendarDateSchema,
  documentTypeSchema,
  invoiceCategorySchema,
  lineItemKindSchema,
} from './extraction.js';
import { validCalendarDateSchema } from './invoice-list.js';
import { invoiceEventTypeSchema, invoiceStatusSchema, rejectionReasonSchema } from './invoices.js';
import {
  MAX_INTEGER_DIGITS,
  aircraftRegistration,
  bankDetails,
  calendarDate,
  currencyCode,
  decimal,
  decimalPlaces,
  flightNumbers,
  iataCode,
  iban,
  icaoCode,
  name,
  swift,
  accountNumber,
  taxId,
  text,
} from './normalize.js';

// T06: editing an invoice, the workflow actions (SPEC §6), their 409s, and the activity log.

/** Optimistic concurrency: the `version` of the invoice the request was made against. */
export const invoiceVersionSchema = z.number({ error: 'version is required' }).int().nonnegative();

// ─── Editing: PATCH /api/invoices/:id ─────────────────────────────────────────
//
// Fields come in the domain shape (decimals as strings, dates 'YYYY-MM-DD', null or "" to clear)
// and are normalized with the extraction's rules (normalize.ts): registration hyphen, flight
// shorthand, IBAN/SWIFT compaction, uppercase codes. A value a rule can't read is refused (400)
// instead of becoming null, so nothing a person typed is dropped silently.

type Rule = (value: string) => string | null;

/** Text through `rule`; null, "" and whitespace clear the field. */
function textField(max: number, rule: Rule = text, invalid = 'Not a valid value') {
  return z
    .string()
    .max(max, { error: `Use at most ${String(max)} characters` })
    .nullable()
    .transform((value, ctx) => {
      if (value === null || value.trim() === '') return null;
      const normalized = rule(value);
      if (normalized === null) {
        ctx.addIssue({ code: 'custom', message: invalid });
        return z.NEVER;
      }
      return normalized;
    });
}

/** A decimal string that fits numeric(18, places): thousands commas allowed, never rounded. */
function decimalField(places: number) {
  return z
    .string()
    .max(40, { error: 'Enter a number like 1234.56' })
    .nullable()
    .transform((value, ctx) => {
      if (value === null || value.trim() === '') return null;
      const normalized = decimal(value);
      if (normalized === null) {
        // A well-formed number that is too long, or not a number at all ("12,34": decimal comma).
        const wellFormed = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(value.replace(/\s/g, ''));
        ctx.addIssue({
          code: 'custom',
          message: wellFormed
            ? `Use at most ${String(MAX_INTEGER_DIGITS)} digits before the decimal point`
            : 'Enter a number like 1234.56',
        });
        return z.NEVER;
      }
      if (decimalPlaces(normalized) > places) {
        ctx.addIssue({ code: 'custom', message: `Use at most ${String(places)} decimals` });
        return z.NEVER;
      }
      return normalized;
    });
}

const dateField = textField(
  10,
  (value) => {
    const date = calendarDate(value);
    return date === null || date.startsWith('0000') ? null : date;
  },
  'Enter a real date',
);

const dayCountField = z
  .number({ error: 'Enter a whole number of days' })
  .int({ error: 'Enter a whole number of days' })
  .min(0, { error: 'Use 0 to 999 days' })
  .max(999, { error: 'Use 0 to 999 days' })
  .nullable();

const currencyField = textField(3, currencyCode, 'Use a 3-letter code like USD');

/** Money columns are numeric(18,4); unit prices numeric(18,6) (SPEC §5). */
const MONEY_DECIMALS = 4;
const UNIT_PRICE_DECIMALS = 6;

export const MAX_LINE_ITEMS = 200;

export const lineItemInputSchema = z.strictObject({
  kind: lineItemKindSchema,
  description: textField(500),
  quantity: decimalField(MONEY_DECIMALS),
  uom: textField(30),
  unitPrice: decimalField(UNIT_PRICE_DECIMALS),
  amount: decimalField(MONEY_DECIMALS),
});

export const bankDetailsInputSchema = z
  .strictObject({
    beneficiary: textField(200, name),
    bankName: textField(200, name),
    iban: textField(60, iban),
    accountNumber: textField(60, accountNumber),
    swift: textField(30, swift),
    routingNumber: textField(60, accountNumber),
    currency: currencyField,
  })
  .nullable()
  // Null when every field is empty; an account number repeating the IBAN is dropped.
  .transform((details) => (details === null ? null : bankDetails(details)));

/** Every editable field (the extracted fields, SPEC §5), in the domain shape. */
export const invoiceEditShape = {
  documentType: documentTypeSchema.nullable(),
  vendorName: textField(300, name),
  vendorTaxId: textField(100, taxId),
  billToName: textField(300, name),
  invoiceNumber: textField(100),
  invoiceDate: dateField,
  serviceDate: dateField,
  /** Setting it makes due_date_source `manual`; clearing it lets it be derived again (§7). */
  dueDate: dateField,
  paymentTermsText: textField(500),
  paymentTermsDays: dayCountField,
  disputeWindowDays: dayCountField,
  category: invoiceCategorySchema.nullable(),
  description: textField(500),
  airportIcao: textField(4, icaoCode, 'Use a 4-letter ICAO code like UGTB'),
  airportIata: textField(3, iataCode, 'Use a 3-letter IATA code like TBS'),
  locationText: textField(200),
  aircraftRegistration: textField(20, aircraftRegistration),
  flightNumbers: z
    .array(z.string().max(30, { error: 'Use at most 30 characters' }))
    .max(30, { error: 'Use at most 30 flight numbers' })
    .transform((values) => flightNumbers(values)),
  currency: currencyField,
  subtotalAmount: decimalField(MONEY_DECIMALS),
  taxAmount: decimalField(MONEY_DECIMALS),
  totalAmount: decimalField(MONEY_DECIMALS),
  amountDue: decimalField(MONEY_DECIMALS),
  amountDueCurrency: currencyField,
  /** Replaces every line. */
  lineItems: z
    .array(lineItemInputSchema)
    .max(MAX_LINE_ITEMS, { error: `Use at most ${String(MAX_LINE_ITEMS)} lines` }),
  /** Replaces the whole value. */
  bankDetails: bankDetailsInputSchema,
  notes: textField(5000),
};

export type EditableField = keyof typeof invoiceEditShape;
export const EDITABLE_FIELDS = Object.keys(invoiceEditShape) as EditableField[];

const partialEditShape = Object.fromEntries(
  EDITABLE_FIELDS.map((key) => [key, invoiceEditShape[key].optional()]),
) as { [K in EditableField]: z.ZodOptional<(typeof invoiceEditShape)[K]> };

/** PATCH /api/invoices/:id: `version` plus any subset of the editable fields. */
export const updateInvoiceRequestSchema = z
  .strictObject({ version: invoiceVersionSchema, ...partialEditShape })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    error: 'Nothing to update',
  });
/** What the client sends. */
export type UpdateInvoiceInput = z.input<typeof updateInvoiceRequestSchema>;
/** What the server works with: normalized. */
export type UpdateInvoiceRequest = z.output<typeof updateInvoiceRequestSchema>;

// ─── Actions: POST /api/invoices/:id/<action> ─────────────────────────────────

/** reextract, undo-payment, reopen. */
export const invoiceVersionRequestSchema = z.strictObject({ version: invoiceVersionSchema });
export type InvoiceVersionRequest = z.infer<typeof invoiceVersionRequestSchema>;

/**
 * POST …/approve. `confirmErrors` approves despite error flags (recorded as overriddenFlags);
 * it can't override missing required fields. `trustBankDetails` adds the invoice's account to
 * the vendor's trusted accounts in the same transaction.
 */
export const approveInvoiceRequestSchema = z.strictObject({
  version: invoiceVersionSchema,
  confirmErrors: z.boolean().optional(),
  trustBankDetails: z.boolean().optional(),
});
export type ApproveInvoiceRequest = z.infer<typeof approveInvoiceRequestSchema>;

const optionalNote = (max: number) =>
  z
    .string()
    .max(max, { error: `Use at most ${String(max)} characters` })
    .nullable()
    .optional()
    .transform((value) => (value === null || value === undefined ? null : text(value)));

/** POST …/reject. A note is required for `other`. */
export const rejectInvoiceRequestSchema = z
  .strictObject({
    version: invoiceVersionSchema,
    reason: rejectionReasonSchema,
    note: optionalNote(1000),
  })
  .refine((body) => body.reason !== 'other' || body.note !== null, {
    path: ['note'],
    error: 'Say why it is rejected',
  });
export type RejectInvoiceInput = z.input<typeof rejectInvoiceRequestSchema>;
export type RejectInvoiceRequest = z.output<typeof rejectInvoiceRequestSchema>;

/**
 * POST …/mark-paid. `paidAt` can't be after today in Asia/Tbilisi (checked by the server's
 * clock: 400). Error flags need `confirmErrors`, as on approve.
 */
export const markPaidRequestSchema = z.strictObject({
  version: invoiceVersionSchema,
  paidAt: validCalendarDateSchema,
  paymentReference: optionalNote(200),
  paymentNote: optionalNote(1000),
  confirmErrors: z.boolean().optional(),
});
export type MarkPaidInput = z.input<typeof markPaidRequestSchema>;
export type MarkPaidRequest = z.output<typeof markPaidRequestSchema>;

// ─── 409s ─────────────────────────────────────────────────────────────────────

export const STALE_MESSAGE = 'Someone else changed this invoice. Reload to see their changes.';

export const workflowErrorCodeSchema = z.enum([
  /** `version` doesn't match: someone else changed the invoice since it was loaded. */
  'STALE',
  /** The action isn't allowed from the invoice's status. */
  'INVALID_TRANSITION',
  /** Approve: a field required for approval is empty (can't be overridden). */
  'MISSING_REQUIRED',
  /** Approve: no vendor is linked. */
  'VENDOR_REQUIRED',
  /** Approve / mark paid: error flags need `confirmErrors: true`. */
  'CONFIRM_REQUIRED',
]);
export type WorkflowErrorCode = z.infer<typeof workflowErrorCodeSchema>;

export const workflowConflictSchema = z.object({
  statusCode: z.literal(409),
  code: workflowErrorCodeSchema,
  message: z.string(),
  /** INVALID_TRANSITION: the invoice's status now. */
  status: invoiceStatusSchema.optional(),
  /** MISSING_REQUIRED: the empty required fields (camelCase paths, as flag fields). */
  fields: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  /** CONFIRM_REQUIRED: the error flags to confirm. */
  flags: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
export type WorkflowConflict = z.infer<typeof workflowConflictSchema>;

// ─── GET /api/invoices/next-to-review ─────────────────────────────────────────

export const nextToReviewQuerySchema = z.strictObject({ after: uuidSchema.optional() });
export type NextToReviewQuery = z.infer<typeof nextToReviewQuerySchema>;

/** The first invoice in To review's default order (not processing, not `after`), or null. */
export const nextToReviewResponseSchema = z.object({ id: uuidSchema.nullable() });
export type NextToReviewResponse = z.infer<typeof nextToReviewResponseSchema>;

// ─── Activity: GET /api/invoices/:id/events ───────────────────────────────────

export const invoiceEventSchema = z.object({
  id: uuidSchema,
  type: invoiceEventTypeSchema,
  at: isoTimestampSchema,
  /** Null = the system (extraction, automatic vendor match). */
  user: namedRefSchema.nullable(),
  /** The vendor `data.vendorId` names (vendor_linked, bank_account_trusted), if it still exists. */
  vendor: namedRefSchema.nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type InvoiceEvent = z.infer<typeof invoiceEventSchema>;

/** Newest first. */
export const invoiceEventsResponseSchema = z.object({ events: z.array(invoiceEventSchema) });
export type InvoiceEventsResponse = z.infer<typeof invoiceEventsResponseSchema>;

// Event data, as written. Bank detail edits carry their values (an audit must show an IBAN
// change); they are never logged.

/** `edited`: `{ field: { from, to } }` for the changed fields only, values in the domain shape. */
export const editedEventDataSchema = z.record(
  z.string(),
  z.object({ from: z.unknown(), to: z.unknown() }),
);
export const approvedEventDataSchema = z.object({ overriddenFlags: z.array(z.string()) });
export const rejectedEventDataSchema = z.object({
  reason: rejectionReasonSchema,
  note: z.string().nullable(),
});
export const paidEventDataSchema = z.object({
  paidAt: calendarDateSchema,
  reference: z.string().nullable(),
  overriddenFlags: z.array(z.string()).optional(),
});
export const paymentUndoneEventDataSchema = z.object({
  previousPaidAt: calendarDateSchema.nullable(),
});
export const reopenedEventDataSchema = z.object({ from: z.enum(['unpaid', 'rejected']) });
export const vendorLinkedEventDataSchema = z.object({
  vendorId: uuidSchema,
  method: z.enum(['name', 'alias', 'email_domain', 'manual']),
});
export const receivedEventDataSchema = z.object({ source: z.enum(['mailgun', 'manual']) });
export const extractionFailedEventDataSchema = z.object({ error: z.string() });
