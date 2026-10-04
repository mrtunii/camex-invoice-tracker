import type { InvoiceFlag } from '@camex/shared';
import { Tooltip, cn } from '@heroui/react';
import { OctagonAlert, TriangleAlert } from 'lucide-react';

type ListFlag = Pick<InvoiceFlag, 'severity' | 'message'>;

/**
 * At most one icon per row (T05b §2): red when the invoice has any error flag, else amber when
 * it has a warning, else nothing. Info flags never show in lists, and codes never show in the UI:
 * the tooltip lists the messages in plain English.
 */
export function FlagIcon({ flags, className }: { flags: ListFlag[]; className?: string }) {
  const errors = flags.filter((flag) => flag.severity === 'error');
  const warnings = flags.filter((flag) => flag.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) return null;

  const isError = errors.length > 0;
  const Icon = isError ? OctagonAlert : TriangleAlert;
  const messages = [...errors, ...warnings].map((flag) => flag.message);
  const summary = `${isError ? 'Needs fixing' : 'Check'}: ${messages.join('. ')}`;

  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger
        aria-label={summary}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-control outline-none focus-visible:focus-ring',
          isError ? 'text-danger' : 'text-caution',
          className,
        )}
      >
        <Icon className="size-4" aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Content placement="top end" className="max-w-xs break-normal whitespace-normal">
        <ul className="space-y-1 text-xs">
          {messages.map((message, i) => (
            <li key={`${String(i)}-${message}`}>{message}</li>
          ))}
        </ul>
      </Tooltip.Content>
    </Tooltip>
  );
}
