import {
  DEFAULT_SORT_ORDER,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type InvoiceSummary,
  businessToday,
} from '@camex/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UploadInvoicesDialog } from '@/components/upload-invoices-dialog';
import { appConfig } from '@/lib/config';
import { formatAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
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
  type ListParams,
  NO_FILTERS,
  effectiveSort,
  hasActiveFilters,
  readListParams,
  writeListParams,
} from './list-params';
import { Pagination } from './pagination';

const TABS: { status: InvoiceListStatus; label: string }[] = [
  { status: 'needs_review', label: 'Needs review' },
  { status: 'unpaid', label: 'Unpaid' },
  { status: 'paid', label: 'Paid' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'all', label: 'All' },
];

const EMPTY_TEXT: Record<InvoiceListStatus, string> = {
  needs_review: 'Nothing to review. New invoices appear here once they are extracted.',
  unpaid: 'No unpaid invoices. Approved invoices wait here until they are paid.',
  paid: 'No paid invoices yet.',
  rejected: 'No rejected invoices.',
  all: 'No invoices yet. Emailed and uploaded invoices appear here.',
};

/** `?…` for a link to the list with `patch` applied (and back to page 1 unless given). */
function hrefWith(params: ListParams, patch: Partial<ListParams>): string {
  const query = writeListParams({ ...params, page: 1, ...patch }).toString();
  return query === '' ? '/invoices' : `/invoices?${query}`;
}

function StatusTabs({
  params,
  counts,
}: {
  params: ListParams;
  counts: InvoiceSummary['counts'] | undefined;
}) {
  return (
    <nav
      aria-label="Invoice status"
      className="-mb-px flex gap-1 overflow-x-auto border-b border-border"
    >
      {TABS.map(({ status, label }) => {
        const current = params.status === status;
        return (
          <Link
            key={status}
            to={hrefWith(params, { status, sort: null, order: null })}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              current && 'border-primary font-medium text-foreground',
            )}
          >
            {label}
            <span
              className={cn(
                'min-w-6 rounded-full bg-muted px-1.5 py-0.5 text-center text-xs tabular-nums',
                current && 'bg-primary text-primary-foreground',
                status === 'needs_review' &&
                  !current &&
                  (counts?.needs_review ?? 0) > 0 &&
                  'bg-attention/25 text-foreground',
              )}
            >
              {counts ? counts[status].toLocaleString('en-US') : '·'}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function SummaryStrip({ params, summary }: { params: ListParams; summary: InvoiceSummary }) {
  const { unpaidTotals, unpaidWithoutAmount, overdueCount, dueNext7Count } = summary;
  const link =
    'rounded underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  return (
    <section
      aria-label="Unpaid summary"
      className="flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">Unpaid</span>
        {unpaidTotals.length === 0 ? (
          <span className="text-muted-foreground">nothing</span>
        ) : (
          // One total per currency, never converted or added together.
          unpaidTotals.map(({ currency, amount }, i) => (
            <span key={currency} className="font-semibold tabular-nums">
              {i > 0 && (
                <span className="mr-2 font-normal text-muted-foreground" aria-hidden>
                  ·
                </span>
              )}
              {formatAmount(amount, currency)}
            </span>
          ))
        )}
        {unpaidWithoutAmount > 0 && (
          <span className="text-muted-foreground">
            + {unpaidWithoutAmount.toLocaleString('en-US')} without amount
          </span>
        )}
      </p>
      <p className="flex gap-x-4">
        <Link
          to={hrefWith(params, { status: 'unpaid', due: 'overdue', sort: null, order: null })}
          className={cn(
            link,
            overdueCount > 0 ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {overdueCount.toLocaleString('en-US')} overdue
        </Link>
        <Link
          to={hrefWith(params, { status: 'unpaid', due: 'soon', sort: null, order: null })}
          className={cn(link, dueNext7Count > 0 ? 'font-medium' : 'text-muted-foreground')}
        >
          {dueNext7Count.toLocaleString('en-US')} due in 7 days
        </Link>
      </p>
    </section>
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

  const onSort = (key: InvoiceSortKey) => {
    const order =
      sort.sort === key ? (sort.order === 'asc' ? 'desc' : 'asc') : DEFAULT_SORT_ORDER[key];
    setSearch(writeListParams({ ...params, sort: key, order, page: 1 }));
  };

  const filtered = hasActiveFilters(params);
  const data = list.data;
  const pastEnd = data !== undefined && data.items.length === 0 && data.total > 0;
  const { inboxAddress } = appConfig;

  const empty = pastEnd ? (
    <p>
      Page {params.page} is past the end.{' '}
      <Link to={hrefWith(params, {})} className="text-foreground underline underline-offset-4">
        Go to page 1
      </Link>
    </p>
  ) : filtered ? (
    <>
      <p>No invoices match these filters.</p>
      <Button variant="outline" className="mt-3" onClick={() => setFilters(NO_FILTERS)}>
        Clear filters
      </Button>
    </>
  ) : (
    <>
      <p>{EMPTY_TEXT[params.status]}</p>
      {inboxAddress !== null && (params.status === 'needs_review' || params.status === 'all') && (
        <p className="mt-2">
          <InboxAddress address={inboxAddress} />
        </p>
      )}
    </>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoices"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => exportCsv.mutate(params)}
              disabled={exportCsv.isPending}
              title="Download the invoices in this tab, with the current filters and sort, as CSV"
            >
              <Download aria-hidden />
              {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
            </Button>
            <UploadInvoicesDialog
              onUploaded={() => {
                void queryClient.invalidateQueries({ queryKey: invoicesQueryKey });
                void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
              }}
            />
          </>
        }
      />

      <div className="space-y-4">
        <StatusTabs params={params} counts={summary.data?.counts} />
        {summary.data && <SummaryStrip params={params} summary={summary.data} />}
        <InvoiceFilters filters={params} onChange={setFilters} />
      </div>

      {list.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Couldn't load invoices: {list.error.message}</span>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <InvoicesTable
            status={params.status}
            items={data?.items ?? []}
            sort={sort}
            onSort={onSort}
            onOpen={(id) => void navigate(`/invoices/${id}`, { state: { from: location.search } })}
            today={today}
            loading={list.isPending}
            stale={list.isPlaceholderData}
            empty={empty}
          />
          {data && (
            <Pagination
              page={params.page}
              pageSize={data.pageSize}
              total={data.total}
              hrefFor={(page) => hrefWith(params, { page })}
            />
          )}
        </>
      )}
    </div>
  );
}
