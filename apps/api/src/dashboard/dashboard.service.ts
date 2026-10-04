import { Inject, Injectable } from '@nestjs/common';
import {
  type AttentionItem,
  type CategoryTotal,
  type Clock,
  DASHBOARD_PANEL_ROWS,
  DASHBOARD_TOP_ROWS,
  DASHBOARD_TREND_MONTHS,
  DISPUTE_SOON_DAYS,
  type Dashboard,
  type DashboardAttention,
  type DashboardLedger,
  type DashboardQuery,
  type MoneyCell,
  type TrendMonth,
  type VendorTotal,
  type YearMonth,
  addDays,
  businessToday,
  invoiceCategorySchema,
} from '@camex/shared';
import { CLOCK } from '../clock/clock.module.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  flagSummariesFromJson,
  fromDateColumn,
  fromDecimalColumn,
} from '../invoices/invoice-columns.js';
import {
  INVOICE_FROM,
  filterConditions,
  inIdOrder,
  orderByClause,
  resolveSort,
  statusCondition,
  whereClause,
} from '../invoices/invoice-query.js';
import { PrismaService } from '../prisma/prisma.service.js';

// GET /api/dashboard (T05b): Home's attention panels, month ledger, trend and ranked lists.
// Every sum is SQL numeric returned as text (trim_scale drops numeric(18,4)'s trailing zeros).
// Months are plain `date` comparisons: [first day, first day of the next month).

/** 'YYYY-MM' plus `n` months (negative goes back). */
function addMonths(month: YearMonth, n: number): YearMonth {
  const [year = 0, mon = 1] = month.split('-').map(Number);
  const index = year * 12 + (mon - 1) + n;
  const y = Math.floor(index / 12);
  return `${String(y).padStart(4, '0')}-${String(index - y * 12 + 1).padStart(2, '0')}`;
}

/** `first` … `last` inclusive, oldest first. */
function monthRange(first: YearMonth, last: YearMonth): YearMonth[] {
  const months: YearMonth[] = [];
  for (let month = first; month <= last; month = addMonths(month, 1)) months.push(month);
  return months;
}

const INVOICE_DATE = Prisma.sql`i.invoice_date`;
const PAID_AT = Prisma.sql`i.paid_at`;

/** `column` (a `date`) within the months `first` … `last`. */
function inMonths(column: Prisma.Sql, first: YearMonth, last: YearMonth = first): Prisma.Sql {
  const from = `${first}-01`;
  const to = `${addMonths(last, 1)}-01`;
  return Prisma.sql`(${column} >= ${from}::date AND ${column} < ${to}::date)`;
}

const INVOICED = Prisma.sql`i.status IN ('unpaid', 'paid')`;
const PAID = Prisma.sql`i.status = 'paid'`;
const UNPAID = Prisma.sql`i.status = 'unpaid'`;
const NEEDS_REVIEW = Prisma.sql`i.status = 'needs_review'`;
const HAS_AMOUNT = Prisma.sql`i.amount_due IS NOT NULL AND i.amount_due_currency IS NOT NULL`;

/** The list tab's status condition, so a panel holds exactly the tab's rows. */
function tabCondition(status: 'needs_review' | 'unpaid'): Prisma.Sql {
  return statusCondition(status) ?? Prisma.sql`true`;
}

const attentionSelect = {
  id: true,
  status: true,
  extractionStatus: true,
  vendor: { select: { name: true } },
  vendorName: true,
  amountDue: true,
  amountDueCurrency: true,
  dueDate: true,
  disputeDeadline: true,
  flags: true,
} satisfies Prisma.InvoiceSelect;

type AttentionRow = Prisma.InvoiceGetPayload<{ select: typeof attentionSelect }>;

interface AttentionCounts {
  to_review: number;
  to_pay: number;
  dispute_soon: number;
  next_dispute_deadline: string | null;
  overdue: number;
  due_soon: number;
  extraction_failed: number;
}

interface MonthTotal {
  month: YearMonth;
  amount: string;
  count: number;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(query: DashboardQuery): Promise<Dashboard> {
    const today = businessToday(this.clock);
    const currentMonth = today.slice(0, 7);
    const month = query.month ?? currentMonth;
    const trendFirst = addMonths(currentMonth, -(DASHBOARD_TREND_MONTHS - 1));

    const [currencies, attention, ledger] = await Promise.all([
      this.invoicedCurrencies(trendFirst, currentMonth),
      this.attention(today),
      this.ledger(month),
    ]);
    const currency = query.currency ?? currencies[0] ?? null;
    const [trend, categories, topVendors] = await Promise.all([
      this.trend(trendFirst, currentMonth, currency),
      currency === null ? [] : this.categories(month, currency),
      currency === null ? [] : this.topVendors(month, currency),
    ]);
    return { today, month, currency, currencies, attention, ledger, trend, categories, topVendors };
  }

  /** Currencies invoiced in the months, most invoices first (ties: alphabetical). */
  private async invoicedCurrencies(first: YearMonth, last: YearMonth): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ currency: string }[]>`
      SELECT i.amount_due_currency AS currency
      ${INVOICE_FROM}
      ${whereClause([INVOICED, inMonths(INVOICE_DATE, first, last), HAS_AMOUNT])}
      GROUP BY i.amount_due_currency
      ORDER BY count(*) DESC, i.amount_due_currency ASC`;
    return rows.map((row) => row.currency);
  }

  private async attention(today: string): Promise<DashboardAttention> {
    const disputeSoon = Prisma.sql`${NEEDS_REVIEW}
      AND i.dispute_deadline BETWEEN ${today}::date AND ${addDays(today, DISPUTE_SOON_DAYS)}::date`;
    // The list's due=overdue and due=soon filters (unpaid only), so the numbers match the links.
    const overdue = Prisma.join(filterConditions({ due: 'overdue' }, today), ' AND ');
    const dueSoon = Prisma.join(filterConditions({ due: 'soon' }, today), ' AND ');

    const [[counts], toReview, toPay] = await Promise.all([
      this.prisma.$queryRaw<AttentionCounts[]>`
        SELECT
          count(*) FILTER (WHERE ${tabCondition('needs_review')})::int AS to_review,
          count(*) FILTER (WHERE ${tabCondition('unpaid')})::int AS to_pay,
          count(*) FILTER (WHERE ${disputeSoon})::int AS dispute_soon,
          to_char(
            min(i.dispute_deadline) FILTER (WHERE ${disputeSoon}), 'YYYY-MM-DD'
          ) AS next_dispute_deadline,
          count(*) FILTER (WHERE ${overdue})::int AS overdue,
          count(*) FILTER (WHERE ${dueSoon})::int AS due_soon,
          count(*) FILTER (
            WHERE ${NEEDS_REVIEW} AND i.extraction_status = 'failed'
          )::int AS extraction_failed
        ${INVOICE_FROM}`,
      this.panelItems('needs_review'),
      this.panelItems('unpaid'),
    ]);
    if (counts === undefined) throw new Error('attention query returned no row');
    return {
      toReview: { count: counts.to_review, items: toReview },
      toPay: { count: counts.to_pay, items: toPay },
      disputeSoonCount: counts.dispute_soon,
      nextDisputeDeadline: counts.next_dispute_deadline,
      overdueCount: counts.overdue,
      dueSoonCount: counts.due_soon,
      extractionFailedCount: counts.extraction_failed,
    };
  }

  /** The first rows of a list tab, in the tab's default sort (SPEC §10). */
  private async panelItems(tab: 'needs_review' | 'unpaid'): Promise<AttentionItem[]> {
    const idRows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id::text AS id
      ${INVOICE_FROM}
      WHERE ${tabCondition(tab)}
      ${orderByClause(resolveSort(tab, {}))}
      LIMIT ${DASHBOARD_PANEL_ROWS}`;
    const ids = idRows.map((row) => row.id);
    const rows = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: attentionSelect,
    });
    return inIdOrder(ids, rows).map(toAttentionItem);
  }

  private async ledger(month: YearMonth): Promise<DashboardLedger> {
    const inMonth = inMonths(INVOICE_DATE, month);
    const [invoiced, paid, toPay, toReview] = await Promise.all([
      this.moneyCells([INVOICED, inMonth]),
      // Cash basis: by payment date, whatever the invoice date.
      this.moneyCells([PAID, inMonths(PAID_AT, month)]),
      this.moneyCells([UNPAID, inMonth]),
      this.moneyCells([NEEDS_REVIEW, inMonth]),
    ]);
    const currencies = new Set(
      [invoiced, paid, toPay, toReview].flatMap((row) => row.map((cell) => cell.currency)),
    );
    return { currencies: [...currencies].sort(), invoiced, paid, toPay, toReview };
  }

  /** amount_due per currency (sorted) over the rows matching `conditions` that have one. */
  private async moneyCells(conditions: Prisma.Sql[]): Promise<MoneyCell[]> {
    const rows = await this.prisma.$queryRaw<MoneyCell[]>`
      SELECT
        i.amount_due_currency AS currency,
        trim_scale(sum(i.amount_due))::text AS amount,
        count(*)::int AS count
      ${INVOICE_FROM}
      ${whereClause([...conditions, HAS_AMOUNT])}
      GROUP BY i.amount_due_currency
      ORDER BY i.amount_due_currency`;
    return rows.map(({ currency, amount, count }) => ({ currency, amount, count }));
  }

  /** Invoiced (by invoice date) and paid (by payment date) per month in `currency`. */
  private async trend(
    first: YearMonth,
    last: YearMonth,
    currency: string | null,
  ): Promise<TrendMonth[]> {
    const [invoiced, paid] =
      currency === null
        ? [new Map<YearMonth, MonthTotal>(), new Map<YearMonth, MonthTotal>()]
        : await Promise.all([
            this.monthTotals(INVOICE_DATE, INVOICED, first, last, currency),
            this.monthTotals(PAID_AT, PAID, first, last, currency),
          ]);
    return monthRange(first, last).map((month) => ({
      month,
      invoiced: invoiced.get(month)?.amount ?? '0',
      invoicedCount: invoiced.get(month)?.count ?? 0,
      paid: paid.get(month)?.amount ?? '0',
      paidCount: paid.get(month)?.count ?? 0,
    }));
  }

  private async monthTotals(
    column: Prisma.Sql,
    status: Prisma.Sql,
    first: YearMonth,
    last: YearMonth,
    currency: string,
  ): Promise<Map<YearMonth, MonthTotal>> {
    const rows = await this.prisma.$queryRaw<MonthTotal[]>`
      SELECT
        to_char(${column}, 'YYYY-MM') AS month,
        trim_scale(sum(i.amount_due))::text AS amount,
        count(*)::int AS count
      ${INVOICE_FROM}
      ${whereClause([
        status,
        inMonths(column, first, last),
        HAS_AMOUNT,
        Prisma.sql`i.amount_due_currency = ${currency}`,
      ])}
      GROUP BY 1`;
    return new Map(rows.map((row) => [row.month, row]));
  }

  /** WHERE for the ledger's invoiced row, in one currency. */
  private invoicedWhere(month: YearMonth, currency: string): Prisma.Sql {
    return whereClause([
      INVOICED,
      inMonths(INVOICE_DATE, month),
      HAS_AMOUNT,
      Prisma.sql`i.amount_due_currency = ${currency}`,
    ]);
  }

  /** Largest first; ties alphabetical by category code, unclassified (null) last. */
  private async categories(month: YearMonth, currency: string): Promise<CategoryTotal[]> {
    const rows = await this.prisma.$queryRaw<
      { category: string | null; amount: string; count: number }[]
    >`
      SELECT
        i.category::text AS category,
        trim_scale(sum(i.amount_due))::text AS amount,
        count(*)::int AS count
      ${INVOICE_FROM}
      ${this.invoicedWhere(month, currency)}
      GROUP BY i.category
      ORDER BY sum(i.amount_due) DESC, i.category::text ASC NULLS LAST
      LIMIT ${DASHBOARD_TOP_ROWS}`;
    return rows.map(({ category, amount, count }) => ({
      category: invoiceCategorySchema.nullable().parse(category),
      amount,
      count,
    }));
  }

  /** Per vendor: the linked vendor's name, else the extracted one. Largest first; ties by name. */
  private async topVendors(month: YearMonth, currency: string): Promise<VendorTotal[]> {
    const rows = await this.prisma.$queryRaw<VendorTotal[]>`
      SELECT
        COALESCE(v.name, i.vendor_name, 'Unknown vendor') AS name,
        trim_scale(sum(i.amount_due))::text AS amount,
        count(*)::int AS count
      ${INVOICE_FROM}
      ${this.invoicedWhere(month, currency)}
      GROUP BY 1
      ORDER BY sum(i.amount_due) DESC, 1 ASC
      LIMIT ${DASHBOARD_TOP_ROWS}`;
    return rows.map(({ name, amount, count }) => ({ name, amount, count }));
  }
}

function toAttentionItem(row: AttentionRow): AttentionItem {
  // Flags are stored errors first, so the first error is the most important one.
  const error = flagSummariesFromJson(row.flags).find((flag) => flag.severity === 'error');
  return {
    id: row.id,
    status: row.status,
    extractionStatus: row.extractionStatus,
    vendorName: row.vendor?.name ?? row.vendorName,
    amountDue: fromDecimalColumn(row.amountDue),
    amountDueCurrency: row.amountDueCurrency,
    dueDate: fromDateColumn(row.dueDate),
    disputeDeadline: fromDateColumn(row.disputeDeadline),
    errorMessage: error?.message ?? null,
  };
}
