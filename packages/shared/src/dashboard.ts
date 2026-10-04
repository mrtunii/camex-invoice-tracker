import { z } from 'zod';
import { uuidSchema } from './common.js';
import {
  calendarDateSchema,
  currencyCodeSchema,
  decimalStringSchema,
  invoiceCategorySchema,
} from './extraction.js';
import { extractionStatusSchema, invoiceStatusSchema } from './invoices.js';

// GET /api/dashboard (T05b): what needs attention and what was spent, for the Home page.
// "Today" and months are business dates in Asia/Tbilisi; every sum is exact (SQL numeric).

/** A calendar month, 'YYYY-MM'. Year 0000 doesn't exist (Postgres refuses it). */
export const yearMonthSchema = z
  .string()
  .regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, { error: 'Use a month as YYYY-MM' });
export type YearMonth = z.infer<typeof yearMonthSchema>;

/** Rows in each Home panel; categories and vendors in each ranked list. */
export const DASHBOARD_PANEL_ROWS = 5;
export const DASHBOARD_TOP_ROWS = 5;
/** Months in the trend chart, ending with the dashboard's month (T06 0b). */
export const DASHBOARD_TREND_MONTHS = 12;

export const dashboardQuerySchema = z.strictObject({
  /** The ledger's month (and the month of categories and top vendors); default: this month. */
  month: yearMonthSchema.optional(),
  /** Currency of the trend, categories and top vendors; default: the server's choice. */
  currency: z.string().trim().toUpperCase().pipe(currencyCodeSchema).optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

const countSchema = z.number().int().nonnegative();

/** One row of the To review / To pay panels: enough to say who, how much and why. */
export const attentionItemSchema = z.object({
  id: uuidSchema,
  /** `processing` and `needs_review` in To review; `unpaid` in To pay. */
  status: invoiceStatusSchema,
  extractionStatus: extractionStatusSchema,
  /** The linked vendor's name, else the extracted one. */
  vendorName: z.string().nullable(),
  amountDue: decimalStringSchema.nullable(),
  amountDueCurrency: currencyCodeSchema.nullable(),
  dueDate: calendarDateSchema.nullable(),
  disputeDeadline: calendarDateSchema.nullable(),
  /** Message of the invoice's first error flag (flags are stored errors first), else null. */
  errorMessage: z.string().nullable(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const attentionPanelSchema = z.object({
  /** Every invoice of the list tab the panel stands for (the tab's count, without filters). */
  count: countSchema,
  /** The first DASHBOARD_PANEL_ROWS of that tab, in the tab's default sort (SPEC §10). */
  items: z.array(attentionItemSchema),
});
export type AttentionPanel = z.infer<typeof attentionPanelSchema>;

export const dashboardAttentionSchema = z.object({
  /** The To review tab: `processing` and `needs_review`. */
  toReview: attentionPanelSchema,
  /** The To pay tab: `unpaid`. */
  toPay: attentionPanelSchema,
  /** `needs_review` with a dispute deadline today … today + DISPUTE_SOON_DAYS. */
  disputeSoonCount: countSchema,
  /** The earliest of those deadlines; null when disputeSoonCount is 0. */
  nextDisputeDeadline: calendarDateSchema.nullable(),
  /** `unpaid`, due before today. */
  overdueCount: countSchema,
  /** `unpaid`, due today … today + DUE_SOON_DAYS (the list's `due=soon`). */
  dueSoonCount: countSchema,
  /** `needs_review` whose extraction failed. */
  extractionFailedCount: countSchema,
});
export type DashboardAttention = z.infer<typeof dashboardAttentionSchema>;

/** A sum of amount_due in one currency, and how many invoices it adds up. */
export const moneyCellSchema = z.object({
  currency: currencyCodeSchema,
  amount: decimalStringSchema,
  count: countSchema,
});
export type MoneyCell = z.infer<typeof moneyCellSchema>;

/**
 * The month ledger. Each row holds one cell per currency that has data in that row, sorted by
 * currency; invoices without an amount due or its currency are left out.
 * - invoiced: `unpaid` or `paid`, invoice_date in the month
 * - paid: `paid`, paid_at in the month (cash basis, whatever the invoice date)
 * - toPay: of the month's invoiced, those still `unpaid`
 * - toReview: `needs_review`, invoice_date in the month (not counted as invoiced yet)
 */
export const dashboardLedgerSchema = z.object({
  /** Every currency that appears in any row, sorted: the table's columns. */
  currencies: z.array(currencyCodeSchema),
  invoiced: z.array(moneyCellSchema),
  paid: z.array(moneyCellSchema),
  toPay: z.array(moneyCellSchema),
  toReview: z.array(moneyCellSchema),
});
export type DashboardLedger = z.infer<typeof dashboardLedgerSchema>;

/** One month of the trend, in the dashboard's currency; empty months are "0" and 0. */
export const trendMonthSchema = z.object({
  month: yearMonthSchema,
  /** As the ledger's invoiced row. */
  invoiced: decimalStringSchema,
  invoicedCount: countSchema,
  /** As the ledger's paid row. */
  paid: decimalStringSchema,
  paidCount: countSchema,
});
export type TrendMonth = z.infer<typeof trendMonthSchema>;

/** Invoiced in the month and currency, per category (null: not classified). */
export const categoryTotalSchema = z.object({
  category: invoiceCategorySchema.nullable(),
  amount: decimalStringSchema,
  count: countSchema,
});
export type CategoryTotal = z.infer<typeof categoryTotalSchema>;

/** Invoiced in the month and currency, per vendor (the linked vendor's name, else the extracted one). */
export const vendorTotalSchema = z.object({
  name: z.string(),
  amount: decimalStringSchema,
  count: countSchema,
});
export type VendorTotal = z.infer<typeof vendorTotalSchema>;

export const dashboardSchema = z.object({
  /** The business day the response was computed for (Asia/Tbilisi). */
  today: calendarDateSchema,
  /** The ledger's month: the request's, else the current one. */
  month: yearMonthSchema,
  /**
   * Currency of `trend`, `categories` and `topVendors`: the request's, else the currency with the
   * most invoiced invoices in the trend period (ties: alphabetical), else null (nothing invoiced).
   */
  currency: currencyCodeSchema.nullable(),
  /** Currencies invoiced in the trend period, most invoices first (ties: alphabetical). */
  currencies: z.array(currencyCodeSchema),
  attention: dashboardAttentionSchema,
  ledger: dashboardLedgerSchema,
  /** DASHBOARD_TREND_MONTHS months, oldest first, ending with `month`. */
  trend: z.array(trendMonthSchema),
  /** Top DASHBOARD_TOP_ROWS by amount (largest first; ties by category); empty without a currency. */
  categories: z.array(categoryTotalSchema),
  /** Top DASHBOARD_TOP_ROWS by amount (largest first; ties by name); empty without a currency. */
  topVendors: z.array(vendorTotalSchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
