import type { AttentionItem, AttentionPanel as PanelData } from '@camex/shared';
import { Link, Spinner } from '@heroui/react';
import type { ReactNode } from 'react';
import { Panel } from '@/components/panel';
import { ToneText } from '@/components/tone';
import type { Reason } from '@/lib/attention';
import { formatAmount, formatCount } from '@/lib/format';

function ReasonLine({ reason }: { reason: Reason }) {
  if (reason.reading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <Spinner size="sm" color="current" className="size-3" aria-hidden />
        {reason.text}
      </span>
    );
  }
  return (
    <ToneText
      text={reason.text}
      tone={reason.tone}
      className={reason.tone === null ? 'text-xs text-muted' : 'text-xs'}
    />
  );
}

function Row({ item, reason }: { item: AttentionItem; reason: Reason }) {
  return (
    <li>
      <Link
        href={`/invoices/${item.id}`}
        className="flex w-full flex-col items-stretch gap-0.5 rounded-control px-3 py-2.5 text-foreground no-underline outline-none hover:bg-surface-secondary hover:no-underline focus-visible:focus-ring"
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate font-medium">
            {item.vendorName ?? (item.status === 'processing' ? 'New invoice' : 'Vendor not read')}
          </span>
          <span className="tabular shrink-0">
            {formatAmount(item.amountDue, item.amountDueCurrency)}
          </span>
        </span>
        <ReasonLine reason={reason} />
      </Link>
    </li>
  );
}

/**
 * To review / To pay on Home: the count, up to five rows in the list's default order (vendor,
 * amount, one line of why) and "View all" to the list tab.
 */
export function AttentionPanel({
  title,
  panel,
  viewAllHref,
  reason,
  empty,
}: {
  title: string;
  panel: PanelData | undefined;
  viewAllHref: string;
  reason: (item: AttentionItem) => Reason;
  empty: ReactNode;
}) {
  const headingId = `panel-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Panel as="section" aria-labelledby={headingId} className="flex flex-col">
      <header className="flex items-baseline justify-between gap-4 px-4 pt-4 pb-2">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <span className="tabular text-muted">
          {panel && panel.count > 0 ? formatCount(panel.count) : ''}
        </span>
      </header>
      {panel === undefined ? (
        <div className="grid flex-1 place-items-center p-6">
          <Spinner size="sm" color="current" className="text-muted" aria-label="Loading" />
        </div>
      ) : panel.count === 0 ? (
        <p className="flex-1 px-4 pt-1 pb-5 text-muted">{empty}</p>
      ) : (
        <>
          <ul className="flex-1 px-1">
            {panel.items.map((item) => (
              <Row key={item.id} item={item} reason={reason(item)} />
            ))}
          </ul>
          <footer className="flex justify-end border-t border-line px-4 py-2.5">
            <Link href={viewAllHref} className="text-primary">
              View all
            </Link>
          </footer>
        </>
      )}
    </Panel>
  );
}
