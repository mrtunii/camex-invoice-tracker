import { type CategoryTotal, type VendorTotal, yearMonthSchema } from '@camex/shared';
import { Button, ListBox, Select, Spinner } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router';
import { useDocumentTitle } from '@/lib/document-title';
import { Panel } from '@/components/panel';
import { UploadInvoicesDialog } from '@/components/upload-invoices-dialog';
import { ATTENTION_LINKS, payReason, reviewReason, statusSentences } from '@/lib/attention';
import { appConfig } from '@/lib/config';
import { addMonths, formatAmount, formatMonth } from '@/lib/format';
import { CATEGORY_LABELS } from '@/lib/invoice-labels';
import { InboxAddress } from '@/pages/inbox/inbox-address';
import { inboxQueryKey } from '@/pages/inbox/inbox-query';
import { invoicesQueryKey } from '@/pages/invoices/invoices-query';
import { AttentionPanel } from './attention-panel';
import { useDashboard } from './home-query';
import { MonthLedger } from './month-ledger';
import { StatusSentence } from './status-sentence';

// Recharts is the heaviest dependency; it loads after the rest of Home.
const TrendChart = lazy(async () => ({ default: (await import('./trend-chart')).TrendChart }));

function RankedList({
  title,
  rows,
  currency,
  empty,
}: {
  title: string;
  rows: { name: string; amount: string }[];
  currency: string | null;
  empty: string;
}) {
  return (
    <Panel as="section" aria-label={title} className="p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {rows.length === 0 || currency === null ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <li key={row.name} className="flex items-baseline justify-between gap-4">
              <span className="min-w-0 break-words">{row.name}</span>
              <span className="tabular shrink-0">{formatAmount(row.amount, currency)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function categoryRows(categories: CategoryTotal[]) {
  return categories.map((c) => ({
    name: c.category === null ? 'Not classified' : CATEGORY_LABELS[c.category],
    amount: c.amount,
  }));
}

function vendorRows(vendors: VendorTotal[]) {
  return vendors.map((v) => ({ name: v.name, amount: v.amount }));
}

/**
 * Home (T05b §3): what needs attention (the status sentence and two panels) and what was spent
 * (the month ledger, the last 12 months, categories and vendors).
 */
export function HomePage() {
  useDocumentTitle('Home');
  const [search, setSearch] = useSearchParams();
  const queryClient = useQueryClient();
  const monthParam = yearMonthSchema.safeParse(search.get('month'));
  const currencyParam = search.get('currency');
  const dashboard = useDashboard(
    monthParam.success ? monthParam.data : null,
    currencyParam !== null && /^[A-Z]{3}$/.test(currencyParam) ? currencyParam : null,
  );
  const data = dashboard.data;
  const { inboxAddress } = appConfig;

  function setParam(key: 'month' | 'currency', value: string | null) {
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  const upload = (
    <UploadInvoicesDialog
      onUploaded={() => {
        void queryClient.invalidateQueries({ queryKey: invoicesQueryKey });
        void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
      }}
    />
  );

  if (dashboard.isError && data === undefined) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Home</h1>
        <p>Couldn’t load Home: {dashboard.error.message}</p>
        <Button variant="outline" onPress={() => void dashboard.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="grid min-h-64 place-items-center">
        <Spinner size="sm" color="current" className="text-muted" aria-label="Loading Home" />
      </div>
    );
  }

  const { attention, today } = data;
  const currentMonth = today.slice(0, 7);
  const shownMonth = monthParam.success ? monthParam.data : currentMonth;
  const sentences = statusSentences(
    {
      toReviewCount: attention.toReview.count,
      disputeSoonCount: attention.disputeSoonCount,
      nextDisputeDeadline: attention.nextDisputeDeadline,
      overdueCount: attention.overdueCount,
      dueSoonCount: attention.dueSoonCount,
      extractionFailedCount: attention.extractionFailedCount,
    },
    today,
  );
  const currencyChoices =
    data.currency !== null && !data.currencies.includes(data.currency)
      ? [...data.currencies, data.currency]
      : data.currencies;

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <StatusSentence sentences={sentences} />
        {upload}
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <AttentionPanel
          title="To review"
          panel={attention.toReview}
          viewAllHref={ATTENTION_LINKS.toReview}
          reason={(item) => reviewReason(item, today)}
          empty={
            inboxAddress === null ? (
              'Nothing to review. Emailed and uploaded invoices appear here once they are read.'
            ) : (
              <>
                Nothing to review. New invoices sent to <InboxAddress address={inboxAddress} bare />{' '}
                appear here.
              </>
            )
          }
        />
        <AttentionPanel
          title="To pay"
          panel={attention.toPay}
          viewAllHref={ATTENTION_LINKS.toPay}
          reason={(item) => payReason(item, today)}
          empty="Nothing to pay. Invoices you approve wait here until they are paid."
        />
      </div>

      <MonthLedger
        month={shownMonth}
        ledger={data.ledger}
        isCurrentMonth={shownMonth >= currentMonth}
        loading={dashboard.isPlaceholderData}
        onMonth={(step) => {
          // From the URL, not the response: a second click while a month loads still moves on.
          const next = addMonths(shownMonth, step);
          setParam('month', next === currentMonth ? null : next);
        }}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Panel as="section" aria-labelledby="trend-heading" className="p-4">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="trend-heading" className="text-base font-semibold">
              Last 12 months
            </h2>
            {currencyChoices.length > 0 && (
              <Select
                aria-label="Currency"
                value={data.currency}
                onChange={(key) => setParam('currency', key === null ? null : String(key))}
                className="w-28"
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox items={currencyChoices.map((code) => ({ id: code }))}>
                    {(option) => (
                      <ListBox.Item id={option.id} textValue={option.id}>
                        {option.id}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    )}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
          </header>
          {data.currency === null ? (
            <p className="text-muted">Nothing invoiced in the last 12 months yet.</p>
          ) : (
            <>
              <p className="mb-2 flex gap-4 text-xs text-muted" aria-hidden>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-primary" />
                  Invoiced
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-muted" />
                  Paid
                </span>
              </p>
              <Suspense fallback={<div className="h-56" />}>
                <TrendChart
                  trend={data.trend}
                  currency={data.currency}
                  currentMonth={currentMonth}
                />
              </Suspense>
            </>
          )}
        </Panel>
        <RankedList
          title="By category"
          rows={categoryRows(data.categories)}
          currency={data.currency}
          empty={`Nothing invoiced in ${formatMonth(data.month)}${data.currency ? ` in ${data.currency}` : ''}.`}
        />
        <RankedList
          title="Top vendors"
          rows={vendorRows(data.topVendors)}
          currency={data.currency}
          empty={`Nothing invoiced in ${formatMonth(data.month)}${data.currency ? ` in ${data.currency}` : ''}.`}
        />
      </div>
    </div>
  );
}
