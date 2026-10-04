import {
  DUE_SOON_DAYS,
  type InvoiceListItem,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type SortOrder,
  dateUrgency,
} from '@camex/shared';
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { FlagCounts } from '@/components/flag-counts';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { TruncatedText } from '@/components/truncated-text';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate, formatMoney, formatTimestampParts } from '@/lib/format';
import { CATEGORY_LABELS } from '@/lib/invoice-labels';
import { cn } from '@/lib/utils';

interface Column {
  id: string;
  header: string;
  /** Fixed width (table-layout: fixed); the vendor column takes the rest. */
  width?: string;
  sortKey?: InvoiceSortKey;
  align?: 'right';
  cell: (item: InvoiceListItem, today: string) => ReactNode;
}

/** Red past the date, amber within `DUE_SOON_DAYS`; the label is for screen readers. */
function DateChip({
  date,
  state,
  label,
}: {
  date: string;
  state: 'passed' | 'soon' | null;
  label: { passed: string; soon: string };
}) {
  return (
    <span
      className={cn(
        'inline-block rounded px-1 -mx-1 whitespace-nowrap',
        state === 'passed' && 'bg-destructive/12 font-medium text-destructive',
        state === 'soon' && 'bg-attention/25 font-medium text-foreground',
      )}
    >
      {formatDate(date)}
      {state !== null && <span className="sr-only"> ({label[state]})</span>}
    </span>
  );
}

const DERIVED_HINT: Record<string, string> = {
  terms: 'Computed from the payment terms on the invoice',
  vendor_default: "Computed from the vendor's default payment terms",
};

function VendorCell({ item, showStatus }: { item: InvoiceListItem; showStatus: boolean }) {
  const name = item.vendor?.name ?? item.vendorName;
  const isNew = item.vendor === null && name !== null;
  const processing = item.status === 'processing';
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {name !== null ? (
        <TruncatedText text={name} lines={2} className="max-w-full font-medium" />
      ) : item.extractionStatus === 'failed' ? (
        <span className="text-destructive">Extraction failed</span>
      ) : !processing ? (
        <span className="text-muted-foreground">—</span>
      ) : null}
      {(isNew || processing || showStatus) && (
        <div className="flex flex-wrap items-center gap-1">
          {processing ? (
            <Badge variant="secondary">
              <Loader2 className="animate-spin" aria-hidden />
              Processing…
            </Badge>
          ) : (
            showStatus && (
              <InvoiceStatusBadge status={item.status} extractionStatus={item.extractionStatus} />
            )
          )}
          {isNew && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[0.625rem] uppercase"
              title="No vendor on file matches this name"
            >
              New
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

const COLUMNS: Record<string, Column> = {
  received: {
    id: 'received',
    header: 'Received',
    width: 'w-[6rem]',
    sortKey: 'received',
    cell: (item) => {
      const { date, time } = formatTimestampParts(item.receivedAt);
      return (
        <>
          <span className="block whitespace-nowrap">{date}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">{time}</span>
        </>
      );
    },
  },
  vendor: { id: 'vendor', header: 'Vendor', cell: () => null }, // rendered with the tab's options
  invoiceNumber: {
    id: 'invoiceNumber',
    header: 'Invoice #',
    width: 'w-[6.5rem]',
    cell: (item) =>
      item.invoiceNumber === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <TruncatedText text={item.invoiceNumber} className="font-mono text-xs" />
      ),
  },
  invoiceDate: {
    id: 'invoiceDate',
    header: 'Invoice date',
    width: 'w-[6rem]',
    sortKey: 'invoiceDate',
    cell: (item) => <span className="whitespace-nowrap">{formatDate(item.invoiceDate)}</span>,
  },
  dueDate: {
    id: 'dueDate',
    header: 'Due date',
    width: 'w-[6rem]',
    sortKey: 'dueDate',
    cell: (item) => {
      if (item.dueDate === null) return <span className="text-muted-foreground">—</span>;
      const hint = item.dueDateSource === null ? undefined : DERIVED_HINT[item.dueDateSource];
      return (
        <>
          <DateChip
            date={item.dueDate}
            state={
              item.dueState === 'overdue' ? 'passed' : item.dueState === 'soon' ? 'soon' : null
            }
            label={{ passed: 'overdue', soon: 'due soon' }}
          />
          {hint !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block w-fit text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
                  derived
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{hint}</TooltipContent>
            </Tooltip>
          )}
        </>
      );
    },
  },
  disputeDeadline: {
    id: 'disputeDeadline',
    header: 'Dispute by',
    width: 'w-[6rem]',
    sortKey: 'disputeDeadline',
    cell: (item, today) =>
      item.disputeDeadline === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <DateChip
          date={item.disputeDeadline}
          state={dateUrgency(item.disputeDeadline, today, DUE_SOON_DAYS)}
          label={{ passed: 'dispute window over', soon: 'dispute window ends soon' }}
        />
      ),
  },
  amountDue: {
    id: 'amountDue',
    header: 'Amount due',
    width: 'w-[7rem]',
    sortKey: 'amountDue',
    align: 'right',
    cell: (item) =>
      item.amountDue === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <>
          <span className="font-medium whitespace-nowrap tabular-nums">
            {formatMoney(item.amountDue)}
          </span>{' '}
          <span className="text-xs text-muted-foreground">{item.amountDueCurrency ?? ''}</span>
        </>
      ),
  },
  category: {
    id: 'category',
    header: 'Category',
    width: 'w-[5.5rem]',
    cell: (item) =>
      item.category === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <TruncatedText text={CATEGORY_LABELS[item.category]} />
      ),
  },
  location: {
    id: 'location',
    header: 'Location',
    width: 'w-[3.75rem]',
    cell: (item) => {
      const location = item.airportIata ?? item.locationText;
      return location === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <TruncatedText text={location} className={cn(item.airportIata && 'font-mono text-xs')} />
      );
    },
  },
  paidAt: {
    id: 'paidAt',
    header: 'Paid on',
    width: 'w-[6rem]',
    sortKey: 'paidAt',
    cell: (item) => <span className="whitespace-nowrap">{formatDate(item.paidAt)}</span>,
  },
  flags: {
    id: 'flags',
    header: 'Flags',
    width: 'w-[5rem]',
    cell: (item) => <FlagCounts flags={item.flags} />,
  },
};

/** Columns per tab (T05 §2): the review tab adds the dispute deadline, the paid tab "Paid on". */
function columnsFor(status: InvoiceListStatus): Column[] {
  const ids = [
    'received',
    'vendor',
    'invoiceNumber',
    'invoiceDate',
    'dueDate',
    ...(status === 'needs_review' ? ['disputeDeadline'] : []),
    'amountDue',
    ...(status === 'paid' ? ['paidAt'] : []),
    'category',
    'location',
    'flags',
  ];
  return ids.map((id) => COLUMNS[id]).filter((column): column is Column => !!column);
}

function SortHeader({
  column,
  sort,
  onSort,
}: {
  column: Column & { sortKey: InvoiceSortKey };
  sort: { sort: InvoiceSortKey; order: SortOrder };
  onSort: (key: InvoiceSortKey) => void;
}) {
  const active = sort.sort === column.sortKey;
  const Icon = !active ? ChevronsUpDown : sort.order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(column.sortKey)}
      className={cn(
        'inline-flex items-center gap-1 rounded text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        column.align === 'right' && 'flex-row-reverse text-right',
        active && 'text-foreground',
      )}
    >
      {column.header}
      <Icon className={cn('size-3.5', !active && 'opacity-40')} aria-hidden />
    </button>
  );
}

function SkeletonRows({ columns }: { columns: Column[] }) {
  return Array.from({ length: 6 }, (_, row) => (
    <TableRow key={row} aria-hidden>
      {columns.map((column) => (
        <TableCell key={column.id}>
          <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

export function InvoicesTable({
  status,
  items,
  sort,
  onSort,
  onOpen,
  today,
  loading,
  stale,
  empty,
}: {
  status: InvoiceListStatus;
  items: InvoiceListItem[];
  sort: { sort: InvoiceSortKey; order: SortOrder };
  onSort: (key: InvoiceSortKey) => void;
  onOpen: (id: string) => void;
  /** Business day (Tbilisi), for the dispute-deadline colours. */
  today: string;
  /** First load: skeleton rows. */
  loading: boolean;
  /** Showing the previous result while the next one loads. */
  stale: boolean;
  /** Shown in place of the rows when there are none. */
  empty: ReactNode;
}) {
  const columns = columnsFor(status);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table
        className={cn(
          'min-w-[59rem] table-fixed text-[0.8125rem]',
          stale && 'opacity-60 transition-opacity',
        )}
        aria-busy={loading || stale}
      >
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} className={column.width} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn(
                  'px-1.5 text-xs leading-tight whitespace-normal first:pl-3 last:pr-3',
                  column.align === 'right' && 'text-right',
                )}
                aria-sort={
                  column.sortKey === undefined
                    ? undefined
                    : sort.sort === column.sortKey
                      ? sort.order === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                }
              >
                {column.sortKey === undefined ? (
                  column.header
                ) : (
                  <SortHeader
                    column={{ ...column, sortKey: column.sortKey }}
                    sort={sort}
                    onSort={onSort}
                  />
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <SkeletonRows columns={columns} />
          ) : items.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="py-12 text-center whitespace-normal text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => (
              <TableRow
                key={item.id}
                tabIndex={0}
                onClick={() => onOpen(item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(item.id);
                }}
                className="cursor-pointer align-top focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      'px-1.5 py-2.5 whitespace-normal first:pl-3 last:pr-3',
                      column.align === 'right' && 'text-right',
                    )}
                  >
                    {column.id === 'vendor' ? (
                      <VendorCell item={item} showStatus={status === 'all'} />
                    ) : (
                      column.cell(item, today)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
