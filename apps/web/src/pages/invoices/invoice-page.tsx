import { businessToday, uuidSchema } from '@camex/shared';
import { Link } from '@heroui/react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';
import { FlagIcon } from '@/components/flag-icon';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatusWord } from '@/components/status-word';
import { ToneText } from '@/components/tone';
import { ApiError } from '@/lib/api';
import { apiUrl } from '@/lib/config';
import { dueCell, formatAmount, formatDay } from '@/lib/format';
import { NotFoundPage } from '@/pages/not-found-page';
import { useInvoice } from './invoices-query';

/** Where "Invoices" goes back to: the list as it was when the row was opened. */
function useBackHref(): string {
  const state: unknown = useLocation().state;
  const from =
    typeof state === 'object' && state !== null && 'from' in state && typeof state.from === 'string'
      ? state.from
      : '';
  return `/invoices${from}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Interim invoice page (T05): the essentials and the PDF. T06 replaces it with the split view. */
export function InvoicePage() {
  const { id = '' } = useParams();
  const valid = uuidSchema.safeParse(id).success;
  const invoice = useInvoice(valid ? id : null);
  const backHref = useBackHref();
  const today = businessToday();

  if (!valid || (invoice.error instanceof ApiError && invoice.error.status === 404)) {
    return <NotFoundPage />;
  }

  const data = invoice.data;
  const vendor = data?.vendor?.name ?? data?.vendorName ?? null;
  const due = data?.dueDate ? dueCell(data.dueDate, today, data.status === 'unpaid') : null;

  return (
    <div className="space-y-6">
      <Link href={backHref} className="gap-1.5 text-muted no-underline hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Invoices
      </Link>

      {invoice.isError ? (
        <p className="text-danger">{invoice.error.message}</p>
      ) : data === undefined ? (
        <p className="text-muted">Loading invoice…</p>
      ) : (
        <>
          <PageHeader
            title={data.invoiceNumber ? `Invoice ${data.invoiceNumber}` : data.fileName}
            description={vendor ?? 'Vendor not read yet'}
            action={
              <Link
                href={apiUrl(`/invoices/${data.id}/file`)}
                target="_blank"
                rel="noopener noreferrer"
                className="button button--outline button--md gap-1.5 no-underline"
              >
                Open PDF
                <ExternalLink className="size-4" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </Link>
            }
          />
          <Panel className="max-w-2xl p-5">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3">
              <Row label="Status">
                <span className="inline-flex items-center gap-2">
                  <StatusWord status={data.status} />
                  <FlagIcon flags={data.flags} />
                </span>
              </Row>
              <Row label="Vendor">{vendor ?? '—'}</Row>
              <Row label="Invoice #">
                <span className="font-mono">{data.invoiceNumber ?? '—'}</span>
              </Row>
              <Row label="Invoice date">{formatDay(data.invoiceDate, today)}</Row>
              <Row label="Due">{due ? <ToneText text={due.text} tone={due.tone} /> : '—'}</Row>
              <Row label="Amount due">
                <span className="tabular">
                  {formatAmount(data.amountDue, data.amountDueCurrency)}
                </span>
              </Row>
              <Row label="File">
                <span className="break-all">{data.fileName}</span>
              </Row>
            </dl>
          </Panel>
          <p className="max-w-prose text-muted">
            Reviewing, editing and approving invoices will be available on this page soon.
          </p>
        </>
      )}
    </div>
  );
}
