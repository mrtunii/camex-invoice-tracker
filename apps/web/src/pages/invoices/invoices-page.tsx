import {
  DEFAULT_SORT_ORDER,
  type DueFilter,
  type InvoiceListResponse,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type InvoiceSummary,
  businessToday,
} from '@camex/shared';
import { Button, Link, Pagination, Tabs, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { type ReactNode, useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { UploadInvoicesDialog } from '@/components/upload-invoices-dialog';
import { appConfig } from '@/lib/config';
import { formatAmount, formatCount, plural } from '@/lib/format';
import { InboxAddress } from '@/pages/inbox/inbox-address';
import { inboxQueryKey } from '@/pages/inbox/inbox-query';
import { InvoiceFilters, type SetFilters } from './invoice-filters';
import { InvoicesTable } from './invoices-table';
import {
  PROCESSING_REFETCH_MS,
  hasProcessing,
  invoicesQueryKey,
  useExportCsv,
  useInvoiceList,
  useInvoiceSummary,
} from './invoices-query';
import {
  NO_FILTERS,
  effectiveSort,
  hasActiveFilters,
  readListParams,
  writeListParams,
} from './list-params';

const TABS: { status: InvoiceListStatus; label: string }[] = [
  { status: 'needs_review', label: 'To review' },
  { status: 'unpaid', label: 'To pay' },
  { status: 'paid', label: 'Paid' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'all', label: 'All' },
];

/** Empty states say what to do next. */
function emptyText(status: InvoiceListStatus, inbox: ReactNode): ReactNode {
  switch (status) {
    case 'needs_review':
      return inbox === null ? (
        'Nothing to review. Emailed and uploaded invoices appear here once they are read.'
      ) : (
        <>Nothing to review. New invoices sent to {inbox} appear here.</>
      );
    case 'unpaid':
      return 'Nothing to pay. Invoices you approve wait here until they are paid.';
    case 'paid':
      return 'Nothing paid yet. Invoices you mark as paid appear here.';
    case 'rejected':
      return 'Nothing rejected.';
    case 'all':
      return inbox === null ? (
        'No invoices yet. Upload PDFs to start.'
      ) : (
        <>No invoices yet. Upload PDFs, or have vendors send them to {inbox}.</>
      );
  }
}

/** 1 … 4 5 [6] 7 8 … 20: the first, the last and two either side of the current page. */
function pageNumbers(page: number, pages: number): (number | 'gap')[] {
  const shown = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const sorted = [...shown].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return sorted.flatMap((n, i) => {
    const previous = sorted[i - 1];
    return previous !== undefined && n - previous > 1 ? ['gap' as const, n] : [n];
  });
}

function ListPagination({
  page,
  data,
  onPage,
}: {
  page: number;
  data: InvoiceListResponse;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (pages <= 1) return null;
  const from = Math.min(data.total, (page - 1) * data.pageSize + 1);
  const to = Math.min(data.total, page * data.pageSize);
  return (
    <Pagination size="sm" className="flex flex-wrap items-center justify-between gap-3">
      <Pagination.Summary className="tabular text-muted">
        {formatCount(from)}–{formatCount(to)} of {formatCount(data.total)}
      </Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous
            isDisabled={page <= 1}
            onPress={() => onPage(page - 1)}
            aria-label="Previous page"
          >
            <Pagination.PreviousIcon />
          </Pagination.Previous>
        </Pagination.Item>
        {pageNumbers(page, pages).map((n, i) =>
          n === 'gap' ? (
            <Pagination.Item key={`gap-${String(i)}`}>
              <Pagination.Ellipsis />
            </Pagination.Item>
          ) : (
            <Pagination.Item key={n}>
              <Pagination.Link
                isActive={n === page}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${String(n)}`}
                onPress={() => onPage(n)}
                className="tabular"
              >
                {n}
              </Pagination.Link>
            </Pagination.Item>
          ),
        )}
        <Pagination.Item>
          <Pagination.Next
            isDisabled={page >= pages}
            onPress={() => onPage(page + 1)}
            aria-label="Next page"
          >
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  );
}

/** One quiet line: "8 invoices · 35,153.08 USD · 88,753.98 GEL" for the tab and filters. */
function TotalsLine({ data }: { data: InvoiceListResponse }) {
  const parts = [
    plural(data.total, 'invoice', 'invoices'),
    // One total per currency, never converted or added together.
    ...data.totals.map(({ currency, amount }) => formatAmount(amount, currency)),
    ...(data.withoutAmount > 0 ? [`${formatCount(data.withoutAmount)} without amount`] : []),
  ];
  return <p className="tabular text-muted">{parts.join(' · ')}</p>;
}

const DUE_CHOICES: { id: DueFilter | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'soon', label: 'This week' },
];

/** To pay: All · Overdue · This week (the `due` filter: before today / today … +7 days). */
function DueControl({ due, onChange }: { due: DueFilter | null; onChange: SetFilters }) {
  return (
    <ToggleButtonGroup
      aria-label="When due"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([due ?? 'all'])}
      onSelectionChange={(keys) => {
        const [key] = [...keys];
        onChange({ due: key === 'overdue' || key === 'soon' ? key : null });
      }}
    >
      {DUE_CHOICES.map(({ id, label }, i) => (
        <ToggleButton key={id} id={id}>
          {i > 0 && <ToggleButtonGroup.Separator />}
          {label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function TabLabel({ label, count }: { label: string; count: number | undefined }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {label}
      {/* The count is plain muted text, never a pill. */}
      <span className="tabular font-normal text-muted">
        {count === undefined ? '' : formatCount(count)}
      </span>
    </span>
  );
}

export function InvoicesPage() {
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => readListParams(search), [search]);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const list = useInvoiceList(params);
  const summary = useInvoiceSummary(
    params,
    hasProcessing(list.data) ? PROCESSING_REFETCH_MS : false,
  );
  const exportCsv = useExportCsv();
  const sort = effectiveSort(params);
  const today = businessToday();

  const setFilters: SetFilters = useCallback(
    (patch, options) => {
      // Read the URL afresh: a debounced search may fire after other changes.
      setSearch((current) => writeListParams({ ...readListParams(current), ...patch, page: 1 }), {
        replace: options?.replace ?? false,
      });
    },
    [setSearch],
  );

  const setStatus = (status: InvoiceListStatus) => {
    // Tabs keep the filters and reset sort and page; "when due" only means something to pay.
    setSearch(
      writeListParams({
        ...params,
        status,
        sort: null,
        order: null,
        page: 1,
        due: status === 'unpaid' ? params.due : null,
      }),
    );
  };

  const onSort = (key: InvoiceSortKey) => {
    const order =
      sort.sort === key ? (sort.order === 'asc' ? 'desc' : 'asc') : DEFAULT_SORT_ORDER[key];
    setSearch(writeListParams({ ...params, sort: key, order, page: 1 }));
  };

  const counts: InvoiceSummary['counts'] | undefined = summary.data?.counts;
  const data = list.data;
  const pastEnd = data !== undefined && data.items.length === 0 && data.total > 0;
  const { inboxAddress } = appConfig;
  const inbox = inboxAddress === null ? null : <InboxAddress address={inboxAddress} bare />;

  const empty = pastEnd ? (
    <p>
      Page {params.page} is past the end.{' '}
      <Link
        onPress={() => setSearch(writeListParams({ ...params, page: 1 }))}
        className="text-primary"
      >
        Go to page 1
      </Link>
    </p>
  ) : hasActiveFilters(params) ? (
    <>
      <p>No invoices match these filters.</p>
      <Button variant="outline" className="mx-auto mt-3" onPress={() => setFilters(NO_FILTERS)}>
        Clear filters
      </Button>
    </>
  ) : (
    <p>{emptyText(params.status, inbox)}</p>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        action={
          <UploadInvoicesDialog
            onUploaded={() => {
              void queryClient.invalidateQueries({ queryKey: invoicesQueryKey });
              void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
            }}
          />
        }
      />

      <Tabs
        variant="secondary"
        selectedKey={params.status}
        onSelectionChange={(key) => {
          const tab = TABS.find((t) => t.status === key);
          if (tab && tab.status !== params.status) setStatus(tab.status);
        }}
      >
        <Tabs.ListContainer className="overflow-x-auto">
          <Tabs.List aria-label="Invoice status" className="min-w-0">
            {TABS.map(({ status, label }) => (
              <Tabs.Tab key={status} id={status} className="w-auto px-3">
                <TabLabel label={label} count={counts?.[status]} />
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id={params.status} className="space-y-4 px-0 pt-5 pb-0">
          <InvoiceFilters filters={params} onChange={setFilters} />

          {(params.status === 'unpaid' || params.due !== null) && (
            <DueControl due={params.due} onChange={setFilters} />
          )}

          <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {data ? <TotalsLine data={data} /> : <span />}
            <Button
              size="sm"
              variant="ghost"
              onPress={() => exportCsv.mutate(params)}
              isPending={exportCsv.isPending}
              aria-label="Export these invoices as CSV"
            >
              <Download aria-hidden />
              {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
            </Button>
          </div>

          {list.isError ? (
            <div className="rounded-panel border border-line bg-surface px-6 py-10 text-center">
              <p>Couldn’t load invoices: {list.error.message}</p>
              <Button
                variant="outline"
                className="mx-auto mt-3"
                onPress={() => void list.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : (
            <>
              <InvoicesTable
                status={params.status}
                items={data?.items ?? []}
                sort={sort}
                onSort={onSort}
                onOpen={(id) =>
                  void navigate(`/invoices/${id}`, { state: { from: location.search } })
                }
                today={today}
                loading={list.isPending}
                stale={list.isPlaceholderData}
                empty={empty}
              />
              {data && (
                <ListPagination
                  page={params.page}
                  data={data}
                  onPage={(page) => setSearch(writeListParams({ ...params, page }))}
                />
              )}
            </>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
