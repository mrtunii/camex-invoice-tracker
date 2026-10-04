import type { InvoiceStatus } from '@camex/shared';
import { Spinner, cn } from '@heroui/react';
import { STATUS_WORDS } from '@/lib/invoice-labels';

/**
 * An invoice status as a 6 px dot and the word; never a pill. Green only for Paid (done);
 * an invoice still being read shows a small spinner and "Reading…" in muted text.
 */
export function StatusWord({ status, className }: { status: InvoiceStatus; className?: string }) {
  if (status === 'processing') return <Reading className={className} />;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          status === 'paid' && 'bg-ok',
          status === 'rejected' && 'border border-muted',
          (status === 'needs_review' || status === 'unpaid') && 'bg-muted',
        )}
      />
      {STATUS_WORDS[status]}
    </span>
  );
}

/** Extraction still running. */
export function Reading({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-muted', className)}
    >
      <Spinner size="sm" color="current" className="size-3.5" aria-hidden />
      Reading…
    </span>
  );
}
