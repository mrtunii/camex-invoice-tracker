import type { InvoiceDetail, InvoiceFlag } from '@camex/shared';
import { Button, Disclosure, Spinner, Tooltip, cn, toast } from '@heroui/react';
import { Copy, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { type ActivityEntry, activityEntry } from '@/lib/activity';
import { formatBytes, formatMoney, formatTimestamp } from '@/lib/format';
import { useInboxEmail } from '@/pages/inbox/inbox-query';
import { useInvoiceEvents } from './detail-query';

// The right pane's blocks around the form: issues, payment details, source email, activity.

const FORM_PATH: Record<string, string> = {
  // The deadline is derived: the window in days is what can be corrected.
  disputeDeadline: 'disputeWindowDays',
};

function isBankFlag(flag: InvoiceFlag): boolean {
  return flag.code === 'BANK_FIRST_SEEN' || flag.code === 'BANK_UNKNOWN';
}

function FlagLine({ flag, onFocus }: { flag: InvoiceFlag; onFocus?: (path: string) => void }) {
  const error = flag.severity === 'error';
  const Icon = error ? OctagonAlert : TriangleAlert;
  const content = (
    <>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="sr-only">{error ? 'Needs fixing: ' : 'Check: '}</span>
      <span>{flag.message}</span>
    </>
  );
  const tone = error ? 'text-danger' : 'text-caution';
  const field = flag.field;
  if (field === null || onFocus === undefined) {
    return <li className={cn('flex gap-2', tone)}>{content}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onFocus(FORM_PATH[field] ?? field)}
        className={cn(
          'flex gap-2 rounded-control text-left outline-none hover:underline focus-visible:focus-ring',
          tone,
        )}
      >
        {content}
      </button>
    </li>
  );
}

/**
 * Error and warning messages, each on its own line in its colour; one with a field focuses it.
 * Info flags go in a quiet line underneath. Codes never appear. Once the invoice is approved, the
 * bank warnings move to the payment details.
 */
export function IssuesList({
  invoice,
  onFocus,
}: {
  invoice: InvoiceDetail;
  onFocus: (path: string) => void;
}) {
  const paying = invoice.status === 'unpaid' || invoice.status === 'paid';
  const issues = invoice.flags.filter(
    (flag) => flag.severity !== 'info' && !(paying && isBankFlag(flag)),
  );
  const info = invoice.flags.filter((flag) => flag.severity === 'info');
  if (issues.length === 0 && info.length === 0) return null;
  return (
    <section aria-label="Issues" className="space-y-2">
      {issues.length > 0 && (
        <ul className="space-y-1.5">
          {issues.map((flag) => (
            <FlagLine key={`${flag.code}-${flag.field ?? ''}`} flag={flag} onFocus={onFocus} />
          ))}
        </ul>
      )}
      {info.length > 0 && (
        <p className="text-xs text-muted">
          For your information: {info.map((flag) => flag.message).join(' · ')}
        </p>
      )}
    </section>
  );
}

function CopyRow({
  label,
  value,
  shown,
  mono,
}: {
  label: string;
  /** What is copied (plain: no thousands separators). */
  value: string | null;
  /** What is shown, if different. */
  shown?: string;
  mono?: boolean;
}) {
  if (value === null) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value ?? '');
      toast.success(`Copied ${label.toLowerCase()}`);
    } catch {
      toast.danger('Couldn’t copy. Select the text and copy it instead.');
    }
  }
  return (
    <div className="contents">
      <dt className="py-1 text-muted">{label}</dt>
      <dd className={cn('min-w-0 py-1 break-all', mono && 'font-mono')}>{shown ?? value}</dd>
      <dd className="py-0.5">
        <Tooltip delay={400} closeDelay={0}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Copy ${label.toLowerCase()}`}
            onPress={() => void copy()}
          >
            <Copy className="text-muted" aria-hidden />
          </Button>
          <Tooltip.Content placement="left">Copy</Tooltip.Content>
        </Tooltip>
      </dd>
    </div>
  );
}

/** What the bank transfer needs, each with a copy button; bank warnings directly above. */
export function PaymentDetails({ invoice }: { invoice: InvoiceDetail }) {
  const bank = invoice.bankDetails;
  const warnings = invoice.flags.filter(isBankFlag);
  return (
    <section aria-labelledby="payment-heading" className="space-y-3">
      <h2 id="payment-heading" className="text-base font-semibold">
        Payment details
      </h2>
      {warnings.length > 0 && (
        <ul className="space-y-1.5">
          {warnings.map((flag) => (
            <FlagLine key={flag.code} flag={flag} />
          ))}
        </ul>
      )}
      <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr_auto] items-start gap-x-4">
        <CopyRow label="Beneficiary" value={bank?.beneficiary ?? null} />
        <CopyRow label="Bank" value={bank?.bankName ?? null} />
        {bank?.iban ? (
          <CopyRow label="IBAN" value={bank.iban} mono />
        ) : (
          <CopyRow label="Account number" value={bank?.accountNumber ?? null} mono />
        )}
        <CopyRow label="SWIFT" value={bank?.swift ?? null} mono />
        <CopyRow label="Routing number" value={bank?.routingNumber ?? null} mono />
        <CopyRow
          label="Amount"
          value={invoice.amountDue}
          shown={
            invoice.amountDue === null
              ? undefined
              : `${formatMoney(invoice.amountDue)} ${invoice.amountDueCurrency ?? ''}`
          }
        />
        <CopyRow label="Payment reference" value={invoice.invoiceNumber} mono />
      </dl>
      {bank === null && <p className="text-muted">The invoice has no bank details.</p>}
    </section>
  );
}

function EmailBody({ emailId }: { emailId: string }) {
  const email = useInboxEmail(emailId);
  if (email.isPending) {
    return <Spinner size="sm" color="current" className="text-muted" aria-label="Loading" />;
  }
  if (email.isError) return <p className="text-danger">{email.error.message}</p>;
  const body = email.data.bodyText;
  return body === null || body.trim() === '' ? (
    <p className="text-muted">The email had no text.</p>
  ) : (
    <pre className="max-h-80 overflow-auto rounded-control bg-surface-secondary p-3 font-sans text-sm whitespace-pre-wrap">
      {body}
    </pre>
  );
}

/** The email (or upload) the PDF came with; the body loads when opened. */
export function SourceEmail({ invoice }: { invoice: InvoiceDetail }) {
  const { email } = invoice;
  const [open, setOpen] = useState(false);
  const manual = email.provider === 'manual';
  return (
    <section aria-labelledby="email-heading" className="space-y-3">
      <h2 id="email-heading" className="text-base font-semibold">
        {manual ? 'Upload' : 'Source email'}
      </h2>
      <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-1">
        {manual ? (
          <>
            <dt className="text-muted">Uploaded by</dt>
            <dd>{email.uploadedBy?.name ?? '—'}</dd>
          </>
        ) : (
          <>
            <dt className="text-muted">From</dt>
            <dd className="break-all">{email.fromAddress ?? '—'}</dd>
            <dt className="text-muted">Subject</dt>
            <dd className="break-words">{email.subject ?? '—'}</dd>
          </>
        )}
        <dt className="text-muted">{manual ? 'Uploaded' : 'Received'}</dt>
        <dd className="tabular">{formatTimestamp(email.receivedAt)}</dd>
        <dt className="text-muted">File</dt>
        <dd className="break-all">{invoice.fileName}</dd>
        {email.ignoredAttachments.length > 0 && (
          <>
            <dt className="text-muted">Not stored</dt>
            <dd>
              <ul>
                {email.ignoredAttachments.map((file) => (
                  <li key={file.filename} className="break-all">
                    {file.filename} <span className="text-muted">({formatBytes(file.size)})</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {!manual && (
        <Disclosure isExpanded={open} onExpandedChange={setOpen}>
          <Disclosure.Heading>
            <Disclosure.Trigger className="inline-flex items-center gap-1 text-primary">
              {open ? 'Hide the email' : 'Show the email'}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>{open && <EmailBody emailId={email.id} />}</Disclosure.Content>
        </Disclosure>
      )}
    </section>
  );
}

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const [showing, setShowing] = useState(false);
  return (
    <li className="space-y-1 border-l border-line pl-3">
      <p>
        {entry.text} <span className="tabular text-xs text-muted">· {entry.when}</span>
      </p>
      {entry.note !== null && <p className="text-muted break-words">“{entry.note}”</p>}
      {entry.changes.length > 0 && (
        <ul className="text-xs text-muted">
          {entry.changes.map((change) => (
            <li key={change.label}>
              {change.label}:{' '}
              <span className={cn('tabular', change.mono && 'font-mono')}>
                {change.from} → {change.to}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entry.details.length > 0 && (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 h-7 text-primary"
            onPress={() => setShowing((s) => !s)}
            aria-expanded={showing}
          >
            {showing ? 'Hide' : 'Show'}
          </Button>
          {showing && (
            <dl className="grid grid-cols-[minmax(5.5rem,max-content)_1fr] gap-x-3 gap-y-1.5 text-xs">
              {entry.details.map((change) => (
                <div key={change.label} className="contents">
                  <dt className="text-muted">{change.label}</dt>
                  <dd className="min-w-0 break-all">
                    <span className="block">
                      <span className="text-muted">Was </span>
                      <span className={cn(change.mono && 'font-mono')}>{change.from}</span>
                    </span>
                    <span className="block">
                      <span className="text-muted">Now </span>
                      <span className={cn(change.mono && 'font-mono')}>{change.to}</span>
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </li>
  );
}

/** Every event as a sentence, newest first. */
export function ActivityLog({ invoice, today }: { invoice: InvoiceDetail; today: string }) {
  const events = useInvoiceEvents(invoice.id, invoice.updatedAt);
  return (
    <section aria-labelledby="activity-heading" className="space-y-3">
      <h2 id="activity-heading" className="text-base font-semibold">
        Activity
      </h2>
      {events.isPending ? (
        <Spinner size="sm" color="current" className="text-muted" aria-label="Loading activity" />
      ) : events.isError ? (
        <p className="text-danger">{events.error.message}</p>
      ) : (
        <ol className="space-y-4">
          {events.data.events.map((event) => (
            <ActivityItem key={event.id} entry={activityEntry(event, today)} />
          ))}
        </ol>
      )}
    </section>
  );
}
