import { FileText, FileX } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatBytes, formatTimestamp } from '@/lib/format';
import { InvoiceChip } from './invoice-chip';
import { useInboxEmail } from './inbox-query';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The full email: who, when, attachments, resulting invoices and the plain-text body. */
export function EmailSheet({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const email = useInboxEmail(emailId);
  const data = email.data;

  return (
    <Sheet open={emailId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="text-base">
            {data ? (data.subject ?? '(no subject)') : 'Email'}
          </SheetTitle>
          <SheetDescription>
            {data
              ? `${data.provider === 'manual' ? 'Uploaded by' : 'From'} ${data.fromAddress ?? 'unknown sender'} · ${formatTimestamp(data.receivedAt)}`
              : email.isError
                ? email.error.message
                : 'Loading…'}
          </SheetDescription>
        </SheetHeader>

        {data && (
          <div className="space-y-6 p-4">
            <Section title={`Invoices (${data.invoices.length})`}>
              {data.invoices.length === 0 ? (
                <p className="text-muted-foreground">No PDF in this email, so no invoice.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.invoices.map((invoice) => (
                    <InvoiceChip key={invoice.id} invoice={invoice} />
                  ))}
                </div>
              )}
            </Section>

            {data.attachments.length > 0 && (
              <Section title={`Attachments (${data.attachments.length})`}>
                <ul className="space-y-1">
                  {data.attachments.map((a, i) => (
                    <li key={`${a.filename}-${String(i)}`} className="flex items-center gap-2">
                      {a.processed ? (
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <FileX className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="min-w-0 truncate font-mono text-xs">{a.filename}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {a.contentType} · {formatBytes(a.size)}
                        {!a.processed && ' · ignored (not a PDF)'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Message">
              {data.bodyText ? (
                <pre className="rounded-md border border-border bg-muted/40 p-3 font-sans text-sm break-words whitespace-pre-wrap">
                  {data.bodyText}
                </pre>
              ) : (
                <p className="text-muted-foreground">
                  {data.provider === 'manual'
                    ? 'Uploaded manually; there is no email body.'
                    : 'No plain-text body.'}
                </p>
              )}
            </Section>

            {data.headers && data.headers.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Headers ({data.headers.length})
                </summary>
                <dl className="mt-2 space-y-1 font-mono text-xs break-all">
                  {data.headers.map(([name, value], i) => (
                    <div key={`${name}-${String(i)}`}>
                      <dt className="inline font-semibold">{name}: </dt>
                      <dd className="inline text-muted-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
