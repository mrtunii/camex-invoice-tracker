import { z } from 'zod';
import { isoTimestampSchema, namedRefSchema, uuidSchema } from './common.js';
import {
  calendarDateSchema,
  currencyCodeSchema,
  decimalStringSchema,
  invoiceCategorySchema,
} from './extraction.js';
import {
  dueDateSourceSchema,
  extractionStatusSchema,
  invoiceFlagSchema,
  invoiceStatusSchema,
} from './invoices.js';

// GET /api/invoices, /api/invoices/summary and /api/invoices/export.csv (T05).

/** List tabs. `needs_review` also holds invoices still `processing` (SPEC §10). */
export const invoiceListStatusSchema = z.enum([
  'needs_review',
  'unpaid',
  'paid',
  'rejected',
  'all',
]);
export type InvoiceListStatus = z.infer<typeof invoiceListStatusSchema>;

export const invoiceSortKeySchema = z.enum([
  'received',
  'invoiceDate',
  'dueDate',
  'disputeDeadline',
  'amountDue',
  'paidAt',
]);
export type InvoiceSortKey = z.infer<typeof invoiceSortKeySchema>;

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** `failed`: the extraction failed (the invoice was entered, or still has to be, by hand). */
export const extractionFilterSchema = z.enum(['failed']);
export type ExtractionFilter = z.infer<typeof extractionFilterSchema>;

/** `overdue`: unpaid, due before today. `soon`: unpaid, due today … today + DUE_SOON_DAYS. */
export const dueFilterSchema = z.enum(['overdue', 'soon']);
export type DueFilter = z.infer<typeof dueFilterSchema>;

/**
 * SPEC §6 "due soon": due today … today + 7 days. One window everywhere: `dueState: soon`, the
 * `due=soon` filter ("This week"), the summary's dueNext7Count and Home's due-this-week count.
 */
export const DUE_SOON_DAYS = 7;
/** SPEC §8 DISPUTE_SOON: a dispute deadline within 3 days (passed included) needs attention. */
export const DISPUTE_SOON_DAYS = 3;

export const INVOICE_PAGE_SIZE = 50;
export const MAX_INVOICE_PAGE_SIZE = 200;
export const MAX_CSV_EXPORT_ROWS = 10_000;

/** Sort when the request has none (SPEC §10); ties break by received, then id, same direction. */
export const DEFAULT_INVOICE_SORT: Record<
  InvoiceListStatus,
  { sort: InvoiceSortKey; order: SortOrder }
> = {
  needs_review: { sort: 'disputeDeadline', order: 'asc' },
  unpaid: { sort: 'dueDate', order: 'asc' },
  paid: { sort: 'paidAt', order: 'desc' },
  rejected: { sort: 'received', order: 'desc' },
  all: { sort: 'received', order: 'desc' },
};

/** Direction used when `sort` comes without `order`: deadlines soonest first, the rest newest/largest first. */
export const DEFAULT_SORT_ORDER: Record<InvoiceSortKey, SortOrder> = {
  received: 'desc',
  invoiceDate: 'desc',
  dueDate: 'asc',
  disputeDeadline: 'asc',
  amountDue: 'desc',
  paidAt: 'desc',
};

/** A real calendar date: '2026-02-30' and year 0000 (Postgres has no year 0) are refused. */
export const validCalendarDateSchema = calendarDateSchema.refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !value.startsWith('0000') &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}, 'Not a valid date');

/** Query strings carry text only; `hasErrors=false` is the same as leaving it out. */
const queryBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Filters shared by the list, the summary and the CSV export. */
const invoiceFilterShape = {
  /** Case-insensitive substring of vendor (extracted or linked), invoice #, registration, flight. */
  q: z.string().trim().min(2, 'Search needs at least 2 characters').max(200).optional(),
  vendorId: uuidSchema.optional(),
  category: invoiceCategorySchema.optional(),
  /** amount_due_currency. */
  currency: z.string().trim().toUpperCase().pipe(currencyCodeSchema).optional(),
  invoiceDateFrom: validCalendarDateSchema.optional(),
  invoiceDateTo: validCalendarDateSchema.optional(),
  hasErrors: queryBooleanSchema.optional(),
  due: dueFilterSchema.optional(),
  extraction: extractionFilterSchema.optional(),
};

const dateRangeIssue = {
  message: 'invoiceDateFrom must not be after invoiceDateTo',
  path: ['invoiceDateTo'],
};

function dateRangeOk(query: { invoiceDateFrom?: string; invoiceDateTo?: string }): boolean {
  const { invoiceDateFrom: from, invoiceDateTo: to } = query;
  return from === undefined || to === undefined || from <= to;
}

const statusShape = { status: invoiceListStatusSchema.default('needs_review') };
const sortShape = { sort: invoiceSortKeySchema.optional(), order: sortOrderSchema.optional() };

/** GET /api/invoices. Unknown parameters are refused (400). */
export const invoiceListQuerySchema = z
  .strictObject({
    ...invoiceFilterShape,
    ...statusShape,
    ...sortShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_INVOICE_PAGE_SIZE).default(INVOICE_PAGE_SIZE),
  })
  .refine(dateRangeOk, dateRangeIssue);
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

/** GET /api/invoices/summary: the list's filters without status, sort or pagination. */
export const invoiceSummaryQuerySchema = z
  .strictObject(invoiceFilterShape)
  .refine(dateRangeOk, dateRangeIssue);
export type InvoiceSummaryQuery = z.infer<typeof invoiceSummaryQuerySchema>;

/** GET /api/invoices/export.csv: the list's filters, status and sort, without pagination. */
export const invoiceExportQuerySchema = z
  .strictObject({ ...invoiceFilterShape, ...statusShape, ...sortShape })
  .refine(dateRangeOk, dateRangeIssue);
export type InvoiceExportQuery = z.infer<typeof invoiceExportQuerySchema>;

/** The filters of a list/summary/export query (no status, sort or pagination). */
export type InvoiceFilters = InvoiceSummaryQuery;

/** Unpaid and due before today, or due today … today + DUE_SOON_DAYS (SPEC §6). */
export const dueStateSchema = z.enum(['overdue', 'soon']);
export type DueState = z.infer<typeof dueStateSchema>;

export const invoiceListItemSchema = z.object({
  id: uuidSchema,
  status: invoiceStatusSchema,
  extractionStatus: extractionStatusSchema,
  /** When the email (or upload) carrying the PDF arrived. */
  receivedAt: isoTimestampSchema,
  /** The linked vendor, or null (then `vendorName` is what the invoice says). */
  vendor: namedRefSchema.nullable(),
  vendorName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: calendarDateSchema.nullable(),
  dueDate: calendarDateSchema.nullable(),
  dueDateSource: dueDateSourceSchema.nullable(),
  disputeDeadline: calendarDateSchema.nullable(),
  amountDue: decimalStringSchema.nullable(),
  amountDueCurrency: currencyCodeSchema.nullable(),
  category: invoiceCategorySchema.nullable(),
  airportIata: z.string().nullable(),
  locationText: z.string().nullable(),
  /** Without `field`; the list shows one icon whose tooltip lists the messages (T05b). */
  flags: z.array(invoiceFlagSchema.pick({ code: true, severity: true, message: true })),
  paidAt: calendarDateSchema.nullable(),
  /** Only for `unpaid` invoices, against today in Asia/Tbilisi. */
  dueState: dueStateSchema.nullable(),
});
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>;

/** An amount per currency, summed in SQL (never converted or added across currencies). */
export const currencyTotalSchema = z.object({
  currency: currencyCodeSchema,
  amount: decimalStringSchema,
});
export type CurrencyTotal = z.infer<typeof currencyTotalSchema>;

export const invoiceListResponseSchema = z.object({
  items: z.array(invoiceListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** amount_due per amount_due_currency over every row of the tab and filters (not just the page), sorted by currency. */
  totals: z.array(currencyTotalSchema),
  /** Rows of the tab and filters left out of `totals`: no amount due or no currency. */
  withoutAmount: z.number().int().nonnegative(),
});
export type InvoiceListResponse = z.infer<typeof invoiceListResponseSchema>;

const countSchema = z.number().int().nonnegative();

export const invoiceSummarySchema = z.object({
  /** Per tab, under the request's filters. `needs_review` includes `processing`. */
  counts: z.object({
    needs_review: countSchema,
    unpaid: countSchema,
    paid: countSchema,
    rejected: countSchema,
    all: countSchema,
  }),
  /** Unpaid amount_due summed per amount_due_currency (never converted), sorted by currency. */
  unpaidTotals: z.array(currencyTotalSchema),
  /** Unpaid invoices left out of unpaidTotals: no amount due or no currency. */
  unpaidWithoutAmount: countSchema,
  overdueCount: countSchema,
  /** Unpaid, due today … today + DUE_SOON_DAYS (7). */
  dueNext7Count: countSchema,
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;
