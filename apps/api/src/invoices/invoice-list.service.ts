import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  type Clock,
  DUE_NEXT_DAYS,
  DUE_SOON_DAYS,
  type DueState,
  type InvoiceExportQuery,
  type InvoiceListItem,
  type InvoiceListQuery,
  type InvoiceListResponse,
  type InvoiceStatus,
  type InvoiceSummary,
  type InvoiceSummaryQuery,
  MAX_CSV_EXPORT_ROWS,
  addDays,
  businessToday,
  dateUrgency,
  invoiceFlagSchema,
} from '@camex/shared';
import { z } from 'zod';
import { CLOCK } from '../clock/clock.module.js';
import type { Env } from '../config/env.js';
import { ENV } from '../config/env.module.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type CsvCell, csvDocument } from './invoice-csv.js';
import { fromDateColumn, fromDecimalColumn } from './invoice-columns.js';
import {
  INVOICE_FROM,
  filterConditions,
  orderByClause,
  resolveSort,
  statusCondition,
  whereClause,
} from './invoice-query.js';

const listSelect = {
  id: true,
  status: true,
  extractionStatus: true,
  inboundEmail: { select: { receivedAt: true } },
  vendor: { select: { id: true, name: true } },
  vendorName: true,
  invoiceNumber: true,
  invoiceDate: true,
  dueDate: true,
  dueDateSource: true,
  disputeDeadline: true,
  amountDue: true,
  amountDueCurrency: true,
  category: true,
  airportIata: true,
  locationText: true,
  flags: true,
  paidAt: true,
} satisfies Prisma.InvoiceSelect;

const exportSelect = {
  ...listSelect,
  totalAmount: true,
  currency: true,
  description: true,
  aircraftRegistration: true,
  flightNumbers: true,
  approvedAt: true,
  paymentReference: true,
} satisfies Prisma.InvoiceSelect;

type ListRow = Prisma.InvoiceGetPayload<{ select: typeof listSelect }>;
type ExportRow = Prisma.InvoiceGetPayload<{ select: typeof exportSelect }>;

const storedFlagsSchema = z.array(invoiceFlagSchema.pick({ code: true, severity: true }));

const CSV_COLUMNS = [
  'id',
  'status',
  'received_at',
  'vendor',
  'invoice_number',
  'invoice_date',
  'due_date',
  'dispute_deadline',
  'amount_due',
  'amount_due_currency',
  'total_amount',
  'currency',
  'category',
  'description',
  'airport',
  'aircraft_registration',
  'flight_numbers',
  'flags',
  'approved_at',
  'paid_at',
  'payment_reference',
  'url',
] as const;

/** Overdue / due soon (SPEC §6): unpaid invoices only. */
function dueStateOf(status: InvoiceStatus, dueDate: string | null, today: string): DueState | null {
  if (status !== 'unpaid' || dueDate === null) return null;
  const urgency = dateUrgency(dueDate, today, DUE_SOON_DAYS);
  return urgency === 'passed' ? 'overdue' : urgency;
}

/** `rows` in the order of `ids` (a row deleted in between is skipped). */
function inIdOrder<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

interface SummaryCounts {
  needs_review: number;
  unpaid: number;
  paid: number;
  rejected: number;
  total: number;
  unpaid_without_amount: number;
  overdue: number;
  due_next: number;
}

@Injectable()
export class InvoiceListService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(query: InvoiceListQuery): Promise<InvoiceListResponse> {
    const today = businessToday(this.clock);
    const where = whereClause([statusCondition(query.status), ...filterConditions(query, today)]);
    const orderBy = orderByClause(resolveSort(query.status, query));
    const offset = (query.page - 1) * query.pageSize;

    const [total, ids] = await Promise.all([
      this.count(where),
      this.orderedIds(where, orderBy, query.pageSize, offset),
    ]);
    const rows = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: listSelect,
    });
    return {
      items: inIdOrder(ids, rows).map((row) => this.toListItem(row, today)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async summary(query: InvoiceSummaryQuery): Promise<InvoiceSummary> {
    const today = businessToday(this.clock);
    const filters = filterConditions(query, today);
    const nextEnd = addDays(today, DUE_NEXT_DAYS);

    const [counts, totals] = await Promise.all([
      this.prisma.$queryRaw<SummaryCounts[]>`
        SELECT
          count(*) FILTER (WHERE i.status IN ('processing', 'needs_review'))::int AS needs_review,
          count(*) FILTER (WHERE i.status = 'unpaid')::int AS unpaid,
          count(*) FILTER (WHERE i.status = 'paid')::int AS paid,
          count(*) FILTER (WHERE i.status = 'rejected')::int AS rejected,
          count(*)::int AS total,
          count(*) FILTER (
            WHERE i.status = 'unpaid' AND (i.amount_due IS NULL OR i.amount_due_currency IS NULL)
          )::int AS unpaid_without_amount,
          count(*) FILTER (WHERE i.status = 'unpaid' AND i.due_date < ${today}::date)::int AS overdue,
          count(*) FILTER (
            WHERE i.status = 'unpaid' AND i.due_date BETWEEN ${today}::date AND ${nextEnd}::date
          )::int AS due_next
        ${INVOICE_FROM}
        ${whereClause(filters)}`,
      // Summed in SQL as numeric (exact); trim_scale drops the trailing zeros of numeric(18,4).
      this.prisma.$queryRaw<{ currency: string; amount: string }[]>`
        SELECT i.amount_due_currency AS currency, trim_scale(sum(i.amount_due))::text AS amount
        ${INVOICE_FROM}
        ${whereClause([
          ...filters,
          Prisma.sql`i.status = 'unpaid'`,
          Prisma.sql`i.amount_due IS NOT NULL`,
          Prisma.sql`i.amount_due_currency IS NOT NULL`,
        ])}
        GROUP BY i.amount_due_currency
        ORDER BY i.amount_due_currency`,
    ]);

    const row = counts[0];
    if (row === undefined) throw new Error('summary query returned no row');
    return {
      counts: {
        needs_review: row.needs_review,
        unpaid: row.unpaid,
        paid: row.paid,
        rejected: row.rejected,
        all: row.total,
      },
      unpaidTotals: totals.map(({ currency, amount }) => ({ currency, amount })),
      unpaidWithoutAmount: row.unpaid_without_amount,
      overdueCount: row.overdue,
      dueNext7Count: row.due_next,
    };
  }

  /** The list's rows (same filters, status and sort) as CSV; refused above 10,000 rows. */
  async exportCsv(query: InvoiceExportQuery): Promise<{ fileName: string; content: string }> {
    const today = businessToday(this.clock);
    const where = whereClause([statusCondition(query.status), ...filterConditions(query, today)]);
    const orderBy = orderByClause(resolveSort(query.status, query));

    const ids = await this.orderedIds(where, orderBy, MAX_CSV_EXPORT_ROWS + 1, 0);
    if (ids.length > MAX_CSV_EXPORT_ROWS) {
      throw new BadRequestException(
        `More than ${MAX_CSV_EXPORT_ROWS.toLocaleString('en-US')} invoices match. Narrow the filter to export them.`,
      );
    }
    const rows = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: exportSelect,
    });
    return {
      fileName: `invoices-${query.status}-${today}.csv`,
      content: csvDocument(
        CSV_COLUMNS,
        inIdOrder(ids, rows).map((row) => this.toCsvRow(row)),
      ),
    };
  }

  private async count(where: Prisma.Sql): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total ${INVOICE_FROM} ${where}`;
    return row?.total ?? 0;
  }

  private async orderedIds(
    where: Prisma.Sql,
    orderBy: Prisma.Sql,
    limit: number,
    offset: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id::text AS id ${INVOICE_FROM} ${where} ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((row) => row.id);
  }

  private toListItem(row: ListRow, today: string): InvoiceListItem {
    const dueDate = fromDateColumn(row.dueDate);
    return {
      id: row.id,
      status: row.status,
      extractionStatus: row.extractionStatus,
      receivedAt: row.inboundEmail.receivedAt.toISOString(),
      vendor: row.vendor,
      vendorName: row.vendorName,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: fromDateColumn(row.invoiceDate),
      dueDate,
      dueDateSource: row.dueDateSource,
      disputeDeadline: fromDateColumn(row.disputeDeadline),
      amountDue: fromDecimalColumn(row.amountDue),
      amountDueCurrency: row.amountDueCurrency,
      category: row.category,
      airportIata: row.airportIata,
      locationText: row.locationText,
      flags: storedFlagsSchema.parse(row.flags),
      paidAt: fromDateColumn(row.paidAt),
      dueState: dueStateOf(row.status, dueDate, today),
    };
  }

  private toCsvRow(row: ExportRow): CsvCell[] {
    const [webOrigin] = this.env.WEB_ORIGINS;
    return [
      row.id,
      row.status,
      row.inboundEmail.receivedAt.toISOString(),
      row.vendor?.name ?? row.vendorName,
      row.invoiceNumber,
      fromDateColumn(row.invoiceDate),
      fromDateColumn(row.dueDate),
      fromDateColumn(row.disputeDeadline),
      { amount: fromDecimalColumn(row.amountDue) },
      row.amountDueCurrency,
      { amount: fromDecimalColumn(row.totalAmount) },
      row.currency,
      row.category,
      row.description,
      // As the list's Location column: IATA, else the location as printed.
      row.airportIata ?? row.locationText,
      row.aircraftRegistration,
      row.flightNumbers.join(' '),
      storedFlagsSchema
        .parse(row.flags)
        .map((flag) => flag.code)
        .join(' '),
      row.approvedAt?.toISOString() ?? null,
      fromDateColumn(row.paidAt),
      row.paymentReference,
      `${webOrigin ?? ''}/invoices/${row.id}`,
    ];
  }
}
