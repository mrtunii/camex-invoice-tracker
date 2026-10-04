import {
  DEFAULT_INVOICE_SORT,
  DEFAULT_SORT_ORDER,
  DUE_SOON_DAYS,
  type InvoiceFilters,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type SortOrder,
  addDays,
} from '@camex/shared';
import { Prisma } from '../generated/prisma/client.js';

// SQL for the invoices list, summary and CSV export (T05) and Home (T05b). Every query reads the
// same FROM, so the filters mean the same thing everywhere. Values are always bound parameters; the only
// interpolated SQL comes from the fixed tables below.

/** `i` = invoices, `v` = the linked vendor (nullable), `e` = the email that carried the PDF. */
export const INVOICE_FROM = Prisma.sql`
  FROM invoices i
  JOIN inbound_emails e ON e.id = i.inbound_email_id
  LEFT JOIN vendors v ON v.id = i.vendor_id`;

const STATUS_CONDITION: Record<InvoiceListStatus, Prisma.Sql | null> = {
  needs_review: Prisma.sql`i.status IN ('processing', 'needs_review')`,
  unpaid: Prisma.sql`i.status = 'unpaid'`,
  paid: Prisma.sql`i.status = 'paid'`,
  rejected: Prisma.sql`i.status = 'rejected'`,
  all: null,
};

/** LIKE pattern matching `text` anywhere; `%`, `_` and `\` in it are literal. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The filter conditions (AND-ed); `today` is the business day in Asia/Tbilisi. */
export function filterConditions(filters: InvoiceFilters, today: string): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.q !== undefined) {
    const pattern = containsPattern(filters.q);
    conditions.push(Prisma.sql`(
      i.vendor_name ILIKE ${pattern}
      OR v.name ILIKE ${pattern}
      OR i.invoice_number ILIKE ${pattern}
      OR i.aircraft_registration ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM unnest(i.flight_numbers) AS f(number) WHERE f.number ILIKE ${pattern})
    )`);
  }
  if (filters.vendorId !== undefined) {
    conditions.push(Prisma.sql`i.vendor_id = ${filters.vendorId}::uuid`);
  }
  if (filters.category !== undefined) {
    conditions.push(Prisma.sql`i.category = ${filters.category}::invoice_category`);
  }
  if (filters.currency !== undefined) {
    conditions.push(Prisma.sql`i.amount_due_currency = ${filters.currency}`);
  }
  if (filters.invoiceDateFrom !== undefined) {
    conditions.push(Prisma.sql`i.invoice_date >= ${filters.invoiceDateFrom}::date`);
  }
  if (filters.invoiceDateTo !== undefined) {
    conditions.push(Prisma.sql`i.invoice_date <= ${filters.invoiceDateTo}::date`);
  }
  if (filters.hasErrors === true) {
    // jsonb containment: some element of the flags array has severity "error".
    conditions.push(Prisma.sql`i.flags @> '[{"severity": "error"}]'::jsonb`);
  }
  if (filters.extraction === 'failed') {
    conditions.push(Prisma.sql`i.extraction_status = 'failed'`);
  }
  if (filters.due === 'overdue') {
    conditions.push(Prisma.sql`(i.status = 'unpaid' AND i.due_date < ${today}::date)`);
  } else if (filters.due === 'soon') {
    conditions.push(
      Prisma.sql`(i.status = 'unpaid' AND i.due_date BETWEEN ${today}::date AND ${addDays(today, DUE_SOON_DAYS)}::date)`,
    );
  }
  return conditions;
}

export function statusCondition(status: InvoiceListStatus): Prisma.Sql | null {
  return STATUS_CONDITION[status];
}

/** `WHERE a AND b …`, or nothing. */
export function whereClause(conditions: readonly (Prisma.Sql | null)[]): Prisma.Sql {
  const present = conditions.filter((c): c is Prisma.Sql => c !== null);
  return present.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(present, ' AND ')}`;
}

const SORT_COLUMN: Record<InvoiceSortKey, Prisma.Sql> = {
  received: Prisma.sql`e.received_at`,
  invoiceDate: Prisma.sql`i.invoice_date`,
  dueDate: Prisma.sql`i.due_date`,
  disputeDeadline: Prisma.sql`i.dispute_deadline`,
  amountDue: Prisma.sql`i.amount_due`,
  paidAt: Prisma.sql`i.paid_at`,
};

const DIRECTION: Record<SortOrder, Prisma.Sql> = {
  asc: Prisma.sql`ASC`,
  desc: Prisma.sql`DESC`,
};

export interface ResolvedSort {
  sort: InvoiceSortKey;
  order: SortOrder;
}

/** The request's sort, else the tab's default (SPEC §10); `order` alone flips the default. */
export function resolveSort(
  status: InvoiceListStatus,
  query: { sort?: InvoiceSortKey; order?: SortOrder },
): ResolvedSort {
  if (query.sort === undefined) {
    const fallback = DEFAULT_INVOICE_SORT[status];
    return { sort: fallback.sort, order: query.order ?? fallback.order };
  }
  return { sort: query.sort, order: query.order ?? DEFAULT_SORT_ORDER[query.sort] };
}

/**
 * ORDER BY the key (nulls last in both directions), then received, then id, all in the same
 * direction: a total order, so pages never repeat or skip a row.
 */
export function orderByClause({ sort, order }: ResolvedSort): Prisma.Sql {
  const dir = DIRECTION[order];
  const keys =
    sort === 'received'
      ? [Prisma.sql`e.received_at ${dir}`]
      : [Prisma.sql`${SORT_COLUMN[sort]} ${dir} NULLS LAST`, Prisma.sql`e.received_at ${dir}`];
  return Prisma.sql`ORDER BY ${Prisma.join([...keys, Prisma.sql`i.id ${dir}`], ', ')}`;
}

/** `rows` in the order of `ids` (a row deleted in between is skipped). */
export function inIdOrder<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}
