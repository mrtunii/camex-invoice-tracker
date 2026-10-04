import {
  DISPUTE_SOON_DAYS,
  type InvoiceListItem,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type SortOrder,
  dateUrgency,
} from '@camex/shared';
import { Table, cn } from '@heroui/react';
import type { ReactNode } from 'react';
import { FlagIcon } from '@/components/flag-icon';
import { Reading, StatusWord } from '@/components/status-word';
import { TableEmpty, TablePanel } from '@/components/table-panel';
import { ToneText } from '@/components/tone';
import { TruncatedText } from '@/components/truncated-text';
import { WrappingIdentifier } from '@/components/wrapping-identifier';
import {
  type Tone,
  dueCell,
  formatDate,
  formatDay,
  formatMoney,
  formatTimestampParts,
} from '@/lib/format';
import { CATEGORY_LABELS } from '@/lib/invoice-labels';

interface Column {
  /** The sort key for sortable columns (so it matches the sort descriptor). */
  id: InvoiceSortKey | 'vendor' | 'status' | 'invoiceNumber' | 'category' | 'location' | 'flags';
  header: string;
  /** Fixed width in rem (table-layout: fixed); the vendor column takes the rest. */
  width?: number;
  sortable?: boolean;
  align?: 'end';
  /** Header shown to screen readers only. */
  hiddenHeader?: boolean;
  cell: (item: InvoiceListItem, today: string) => ReactNode;
}

const dash = <span className="text-muted">—</span>;

function DateCell({ date, today }: { date: string | null; today: string }) {
  if (date === null) return dash;
  return <span className="tabular whitespace-nowrap">{formatDay(date, today)}</span>;
}

/** Red once the dispute window has closed, amber within 3 days (SPEC §8); for invoices to review. */
function disputeTone(item: InvoiceListItem, today: string): Tone {
  if (item.disputeDeadline === null || item.status !== 'needs_review') return null;
  const urgency = dateUrgency(item.disputeDeadline, today, DISPUTE_SOON_DAYS);
  return urgency === 'passed' ? 'warning' : urgency === 'soon' ? 'caution' : null;
}

function VendorCell({ item }: { item: InvoiceListItem }) {
  if (item.status === 'processing') return <Reading />;
  const name = item.vendor?.name ?? item.vendorName;
  if (name !== null) return <TruncatedText text={name} lines={2} className="font-medium" />;
  return (
    <span className="text-muted">
      {item.extractionStatus === 'failed' ? "Couldn't read the PDF" : '—'}
    </span>
  );
}

const COLUMNS: Record<Column['id'], Column> = {
  received: {
    id: 'received',
    header: 'Received',
    width: 6.75,
    sortable: true,
    cell: (item, today) => {
      const { day, time } = formatTimestampParts(item.receivedAt, today);
      return (
        <span className="tabular block whitespace-nowrap">
          {day}
          <span className="block text-xs text-muted">{time}</span>
        </span>
      );
    },
  },
  vendor: { id: 'vendor', header: 'Vendor', cell: (item) => <VendorCell item={item} /> },
  status: {
    id: 'status',
    header: 'Status',
    width: 6.5,
    cell: (item) => <StatusWord status={item.status} />,
  },
  invoiceNumber: {
    id: 'invoiceNumber',
    header: 'Invoice #',
    width: 8.5,
    cell: (item) =>
      item.invoiceNumber === null ? (
        dash
      ) : (
        <WrappingIdentifier text={item.invoiceNumber} className="font-mono" />
      ),
  },
  invoiceDate: {
    id: 'invoiceDate',
    header: 'Invoice date',
    width: 6.75,
    sortable: true,
    cell: (item, today) => <DateCell date={item.invoiceDate} today={today} />,
  },
  dueDate: {
    id: 'dueDate',
    header: 'Due',
    width: 8.25,
    sortable: true,
    cell: (item, today) => {
      if (item.dueDate === null) return dash;
      const { text, tone } = dueCell(item.dueDate, today, item.status === 'unpaid');
      return (
        <ToneText
          text={text}
          tone={tone}
          srHint={tone === 'warning' ? `due ${formatDate(item.dueDate)}` : undefined}
          className="tabular whitespace-nowrap"
        />
      );
    },
  },
  disputeDeadline: {
    id: 'disputeDeadline',
    header: 'Dispute by',
    width: 6.75,
    sortable: true,
    cell: (item, today) =>
      item.disputeDeadline === null ? (
        dash
      ) : (
        <ToneText
          text={formatDay(item.disputeDeadline, today)}
          tone={disputeTone(item, today)}
          className="tabular whitespace-nowrap"
        />
      ),
  },
  amountDue: {
    id: 'amountDue',
    header: 'Amount due',
    width: 8.75,
    sortable: true,
    align: 'end',
    cell: (item) =>
      item.amountDue === null ? (
        dash
      ) : (
        <span className="tabular whitespace-nowrap">
          {formatMoney(item.amountDue)}{' '}
          <span className="text-xs text-muted">{item.amountDueCurrency ?? ''}</span>
        </span>
      ),
  },
  paidAt: {
    id: 'paidAt',
    header: 'Paid on',
    width: 6.75,
    sortable: true,
    cell: (item, today) => <DateCell date={item.paidAt} today={today} />,
  },
  category: {
    id: 'category',
    header: 'Category',
    width: 8.25,
    cell: (item) =>
      item.category === null ? dash : <TruncatedText text={CATEGORY_LABELS[item.category]} />,
  },
  location: {
    id: 'location',
    header: 'Location',
    width: 4.5,
    cell: (item) => {
      const location = item.airportIata ?? item.locationText;
      return location === null ? dash : <TruncatedText text={location} />;
    },
  },
  flags: {
    id: 'flags',
    header: 'Flags',
    hiddenHeader: true,
    width: 2.75,
    cell: (item) => <FlagIcon flags={item.flags} />,
  },
};

/** The vendor column never gets narrower than this (rem); it takes whatever else is left. */
const VENDOR_MIN_WIDTH = 9;

/** Columns per tab: To review adds the dispute deadline, Paid "Paid on", All a Status column. */
function columnsFor(status: InvoiceListStatus): Column[] {
  const ids: Column['id'][] = [
    'received',
    'vendor',
    ...(status === 'all' ? (['status'] as const) : []),
    'invoiceNumber',
    'invoiceDate',
    'dueDate',
    ...(status === 'needs_review' ? (['disputeDeadline'] as const) : []),
    'amountDue',
    ...(status === 'paid' ? (['paidAt'] as const) : []),
    'category',
    'location',
    'flags',
  ];
  return ids.map((id) => COLUMNS[id]);
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
  /** Business day (Tbilisi), for relative dates and their colours. */
  today: string;
  /** First load: a spinner instead of rows. */
  loading: boolean;
  /** Showing the previous result while the next one loads. */
  stale: boolean;
  /** Shown in place of the rows when there are none. */
  empty: ReactNode;
}) {
  const columns = columnsFor(status);
  // Below this the table scrolls inside its panel instead of squeezing the vendor out.
  const minWidth = columns.reduce((sum, column) => sum + (column.width ?? VENDOR_MIN_WIDTH), 0);
  return (
    <TablePanel className={cn(stale && 'opacity-60 transition-opacity')}>
      <Table.Content
        aria-label="Invoices"
        aria-busy={loading || stale}
        style={{ minWidth: `${String(minWidth)}rem` }}
        className="table-fixed [&_td]:px-3 [&_th]:px-3"
        sortDescriptor={{
          column: sort.sort,
          direction: sort.order === 'asc' ? 'ascending' : 'descending',
        }}
        onSortChange={(descriptor) => {
          const column = columns.find((c) => c.id === descriptor.column);
          if (column?.sortable) onSort(column.id as InvoiceSortKey);
        }}
        onRowAction={(key) => onOpen(String(key))}
      >
        {/*
         * The columns change with the tab while the previous rows stay on screen: `dependencies`
         * makes React Aria re-render its cached rows instead of mixing old cells with new columns.
         */}
        <Table.Header columns={columns} dependencies={[columns]}>
          {(column) => (
            <Table.Column
              id={column.id}
              isRowHeader={column.id === 'vendor'}
              allowsSorting={column.sortable}
              style={
                column.width === undefined ? undefined : { width: `${String(column.width)}rem` }
              }
              className={cn(column.align === 'end' && 'text-end')}
            >
              {({ sortDirection }) =>
                column.hiddenHeader ? (
                  <span className="sr-only">{column.header}</span>
                ) : column.sortable ? (
                  <Table.SortableColumnHeader
                    sortDirection={sortDirection}
                    className={cn(
                      'gap-1',
                      column.align === 'end' ? 'justify-end' : 'justify-start',
                    )}
                  >
                    {column.header}
                  </Table.SortableColumnHeader>
                ) : (
                  column.header
                )
              }
            </Table.Column>
          )}
        </Table.Header>
        <Table.Body
          items={items}
          dependencies={[columns, today]}
          renderEmptyState={() => <TableEmpty loading={loading}>{empty}</TableEmpty>}
        >
          {(item) => (
            <Table.Row
              id={item.id}
              columns={columns}
              dependencies={[columns, today]}
              className="cursor-pointer align-top"
            >
              {(column) => (
                <Table.Cell className={cn(column.align === 'end' && 'text-end')}>
                  {column.cell(item, today)}
                </Table.Cell>
              )}
            </Table.Row>
          )}
        </Table.Body>
      </Table.Content>
    </TablePanel>
  );
}
