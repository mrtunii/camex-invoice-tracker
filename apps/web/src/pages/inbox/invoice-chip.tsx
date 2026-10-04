import type { InboxInvoice } from '@camex/shared';
import { ExternalLink } from 'lucide-react';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';

/** One invoice created from an email: status, file name and "Open PDF" (new tab). */
export function InvoiceChip({ invoice }: { invoice: InboxInvoice }) {
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background py-1 pr-1 pl-1.5">
      <InvoiceStatusBadge status={invoice.status} extractionStatus={invoice.extractionStatus} />
      <span className="min-w-0 truncate font-mono text-xs" title={invoice.fileName}>
        {invoice.fileName}
      </span>
      <a
        href={`/api/invoices/${invoice.id}/file`}
        target="_blank"
        rel="noopener noreferrer"
        // The row opens the email; the link only opens the PDF.
        onClick={(e) => e.stopPropagation()}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-ring hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Open PDF
        <ExternalLink className="size-3" aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </div>
  );
}
