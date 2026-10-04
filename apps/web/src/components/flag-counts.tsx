import type { FlagSeverity, InvoiceFlag } from '@camex/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const SEVERITIES: { severity: FlagSeverity; label: [string, string]; className: string }[] = [
  {
    severity: 'error',
    label: ['error', 'errors'],
    className: 'bg-destructive/12 text-destructive ring-destructive/30',
  },
  {
    severity: 'warning',
    label: ['warning', 'warnings'],
    className: 'bg-attention/20 text-foreground ring-attention/60',
  },
  {
    severity: 'info',
    label: ['note', 'notes'],
    className: 'bg-muted text-muted-foreground ring-border',
  },
];

/** Validation flags as counts by severity (red, amber, grey); the tooltip lists the codes. */
export function FlagCounts({
  flags,
  className,
}: {
  flags: Pick<InvoiceFlag, 'code' | 'severity'>[];
  className?: string;
}) {
  if (flags.length === 0) return null;
  const groups = SEVERITIES.map((s) => ({
    ...s,
    codes: flags.filter((flag) => flag.severity === s.severity).map((flag) => flag.code),
  })).filter((group) => group.codes.length > 0);
  const summary = groups
    .map((g) => `${g.codes.length} ${g.label[g.codes.length === 1 ? 0 : 1]}`)
    .join(', ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // Focusable so keyboard users get the tooltip too.
          tabIndex={0}
          aria-label={`Flags: ${summary}`}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            className,
          )}
        >
          {groups.map((g) => (
            <span
              key={g.severity}
              className={cn(
                'inline-flex h-5 min-w-5 items-center justify-center rounded px-1 font-mono text-xs font-semibold tabular-nums ring-1 ring-inset',
                g.className,
              )}
            >
              {g.codes.length}
            </span>
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        <dl className="space-y-1">
          {groups.map((g) => (
            <div key={g.severity}>
              <dt className="font-semibold capitalize">{g.label[1]}</dt>
              <dd className="font-mono">{g.codes.join(', ')}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
