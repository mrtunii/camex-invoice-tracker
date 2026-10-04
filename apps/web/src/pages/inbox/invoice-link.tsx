import type { InboxInvoice } from '@camex/shared';
import { Link, cn } from '@heroui/react';
import { FlagIcon } from '@/components/flag-icon';
import { Reading } from '@/components/status-word';
import { TruncatedText } from '@/components/truncated-text';
import { STATUS_WORDS } from '@/lib/invoice-labels';

/**
 * One invoice created from an email, as a plain link: the file name, the status word in muted
 * text and at most one flag icon (T05b §4).
 */
export function InvoiceLink({ invoice, className }: { invoice: InboxInvoice; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <Link href={`/invoices/${invoice.id}`} className="min-w-0 text-sm text-primary">
        <TruncatedText text={invoice.fileName} />
      </Link>
      {invoice.status === 'processing' ? (
        <Reading className="shrink-0 text-xs" />
      ) : (
        <span className="shrink-0 text-xs text-muted">
          {invoice.extractionStatus === 'failed' ? "Couldn't read" : STATUS_WORDS[invoice.status]}
        </span>
      )}
      <FlagIcon flags={invoice.flags} className="-my-1 shrink-0" />
    </span>
  );
}
