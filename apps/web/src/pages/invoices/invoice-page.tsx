import { uuidSchema } from '@camex/shared';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { PageHeader } from '@/components/page-header';
import { ApiError } from '@/lib/api';
import { apiUrl } from '@/lib/config';
import { formatAmount } from '@/lib/format';
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

/** Interim invoice page (T05): the essentials and the PDF. T06 replaces it with the split view. */
export function InvoicePage() {
  const { id = '' } = useParams();
  const valid = uuidSchema.safeParse(id).success;
  const invoice = useInvoice(valid ? id : null);
  const backHref = useBackHref();

  if (!valid || (invoice.error instanceof ApiError && invoice.error.status === 404)) {
    return <NotFoundPage />;
  }

  const data = invoice.data;
  const vendor = data?.vendor?.name ?? data?.vendorName ?? null;
  return (
    <div className="space-y-6">
      <Link
        to={backHref}
        className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Invoices
      </Link>

      {invoice.isError ? (
        <p className="text-destructive">{invoice.error.message}</p>
      ) : data === undefined ? (
        <p className="text-muted-foreground">Loading invoice…</p>
      ) : (
        <>
          <PageHeader
            title={data.invoiceNumber ? `Invoice ${data.invoiceNumber}` : data.fileName}
            description={vendor ?? 'Vendor not extracted'}
            actions={
              <a
                href={apiUrl(`/invoices/${data.id}/file`)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Open PDF
                <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            }
          />
          <dl className="grid max-w-xl grid-cols-[max-content_1fr] gap-x-8 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <InvoiceStatusBadge status={data.status} extractionStatus={data.extractionStatus} />
            </dd>
            <dt className="text-muted-foreground">Vendor</dt>
            <dd>{vendor ?? '—'}</dd>
            <dt className="text-muted-foreground">Invoice #</dt>
            <dd className="font-mono">{data.invoiceNumber ?? '—'}</dd>
            <dt className="text-muted-foreground">Amount due</dt>
            <dd className="tabular-nums">{formatAmount(data.amountDue, data.amountDueCurrency)}</dd>
            <dt className="text-muted-foreground">File</dt>
            <dd className="font-mono break-all">{data.fileName}</dd>
          </dl>
          <p className="max-w-prose text-sm text-muted-foreground">
            Reviewing, editing and approving invoices will be available on this page soon.
          </p>
        </>
      )}
    </div>
  );
}
