import type { DashboardLedger, MoneyCell } from '@camex/shared';
import { Button, Table, cn } from '@heroui/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Panel } from '@/components/panel';
import { formatCount, formatMonth, formatMoney } from '@/lib/format';

const ROWS: { key: keyof Omit<DashboardLedger, 'currencies'>; label: string }[] = [
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'paid', label: 'Paid' },
  { key: 'toPay', label: 'To pay' },
  { key: 'toReview', label: 'To review' },
];

function Cell({ cell }: { cell: MoneyCell | undefined }) {
  if (cell === undefined) return <span className="text-muted">—</span>;
  return (
    <span className="tabular whitespace-nowrap">
      {formatMoney(cell.amount)}{' '}
      {/* On a phone the count goes under the amount, so two currencies fit without scrolling. */}
      <span className="block text-muted sm:inline">({formatCount(cell.count)})</span>
    </span>
  );
}

/**
 * The month in money, one column per currency (never converted). Invoiced and To pay by invoice
 * date, Paid by payment date (cash basis).
 */
export function MonthLedger({
  month,
  ledger,
  onMonth,
  isCurrentMonth,
  loading,
}: {
  month: string;
  ledger: DashboardLedger;
  onMonth: (step: -1 | 1) => void;
  isCurrentMonth: boolean;
  loading: boolean;
}) {
  const columns = [
    { id: '_row', label: 'Month' },
    ...ledger.currencies.map((code) => ({ id: code, label: code })),
  ];
  const rows = ROWS.map((row) => ({
    id: row.key,
    label: row.label,
    cells: new Map(ledger[row.key].map((cell) => [cell.currency, cell])),
  }));

  return (
    <Panel as="section" aria-labelledby="ledger-heading" className="p-4">
      <header className="mb-3 flex items-center gap-1">
        <h2 id="ledger-heading" className="mr-2 text-base font-semibold" aria-live="polite">
          {formatMonth(month)}
        </h2>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Previous month"
          onPress={() => onMonth(-1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Next month"
          isDisabled={isCurrentMonth}
          onPress={() => onMonth(1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </header>

      {ledger.currencies.length === 0 ? (
        <p className="py-4 text-muted">
          {loading
            ? 'Loading…'
            : `Nothing invoiced, paid or waiting for review in ${formatMonth(month)}.`}
        </p>
      ) : (
        <Table
          variant="secondary"
          className={cn('max-w-2xl', loading && 'opacity-60 transition-opacity')}
        >
          <Table.ScrollContainer>
            <Table.Content
              aria-label={`${formatMonth(month)} by currency`}
              className="[&_td]:px-2 [&_th]:px-2 sm:[&_td]:px-4 sm:[&_th]:px-4"
            >
              {/* Another month can bring other currency columns: re-render cached rows. */}
              <Table.Header columns={columns} dependencies={[columns]}>
                {(column) => (
                  <Table.Column
                    id={column.id}
                    isRowHeader={column.id === '_row'}
                    className={column.id === '_row' ? 'sm:w-32' : 'text-end'}
                  >
                    {column.id === '_row' ? (
                      <span className="sr-only">{column.label}</span>
                    ) : (
                      column.label
                    )}
                  </Table.Column>
                )}
              </Table.Header>
              <Table.Body items={rows} dependencies={[columns]}>
                {(row) => (
                  <Table.Row id={row.id} columns={columns} dependencies={[columns]}>
                    {(column) =>
                      column.id === '_row' ? (
                        <Table.Cell className="text-muted">{row.label}</Table.Cell>
                      ) : (
                        <Table.Cell className="text-end">
                          <Cell cell={row.cells.get(column.id)} />
                        </Table.Cell>
                      )
                    }
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      <p className="mt-3 text-xs text-muted">By invoice date; paid by payment date.</p>
    </Panel>
  );
}
