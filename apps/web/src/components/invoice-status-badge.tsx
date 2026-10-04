import type { ExtractionStatus, InvoiceStatus } from '@camex/shared';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const LABELS: Record<InvoiceStatus, string> = {
  processing: 'Processing',
  needs_review: 'Needs review',
  unpaid: 'Unpaid',
  paid: 'Paid',
  rejected: 'Rejected',
};

/** Invoice status (SPEC §6). Amber marks the one state that needs a human now. */
export function InvoiceStatusBadge({
  status,
  extractionStatus,
  className,
}: {
  status: InvoiceStatus;
  extractionStatus?: ExtractionStatus;
  className?: string;
}) {
  const failed = extractionStatus === 'failed';
  return (
    <Badge
      variant={status === 'paid' || status === 'processing' ? 'secondary' : 'outline'}
      className={cn(
        status === 'needs_review' && 'border-attention/60 bg-attention/15 text-foreground',
        status === 'rejected' && 'text-muted-foreground',
        className,
      )}
      title={failed ? 'Extraction failed: enter the data by hand' : undefined}
    >
      {status === 'processing' && <Loader2 className="animate-spin" aria-hidden />}
      {LABELS[status]}
      {failed && <span className="text-destructive">· extraction failed</span>}
    </Badge>
  );
}
