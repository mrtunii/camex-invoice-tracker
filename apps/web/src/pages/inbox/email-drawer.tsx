import { Drawer } from '@heroui/react';
import type { ReactNode } from 'react';
import { formatBytes, formatTimestamp } from '@/lib/format';
import { useInboxEmail } from './inbox-query';
import { InvoiceLink } from './invoice-link';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** The full email: who, when, resulting invoices, attachments and the plain-text body. */
export function EmailDrawer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const email = useInboxEmail(emailId);
  const data = email.data;

  return (
    <Drawer.Backdrop isOpen={emailId !== null} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        {/* Width on the dialog: Drawer.Content is the full-screen layer that places it. */}
        <Drawer.Dialog className="h-full sm:w-[34rem]">
          <Drawer.CloseTrigger />
          <Drawer.Header className="mb-4">
            <Drawer.Heading>{data ? (data.subject ?? '(no subject)') : 'Email'}</Drawer.Heading>
            <p className="text-muted">
              {data
                ? `${data.provider === 'manual' ? 'Uploaded by' : 'From'} ${data.fromAddress ?? 'unknown sender'} · ${formatTimestamp(data.receivedAt)}`
                : email.isError
                  ? email.error.message
                  : 'Loading…'}
            </p>
          </Drawer.Header>
          <Drawer.Body>
            {data && (
              <div className="space-y-8">
                <Section title="Invoices">
                  {data.invoices.length === 0 ? (
                    <p className="text-muted">No PDF in this email, so no invoice.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {data.invoices.map((invoice) => (
                        <li key={invoice.id}>
                          <InvoiceLink invoice={invoice} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                {data.attachments.length > 0 && (
                  <Section title="Attachments">
                    <ul className="space-y-1">
                      {data.attachments.map((a, i) => (
                        <li key={`${a.filename}-${String(i)}`} className="flex min-w-0 gap-2">
                          <span className="min-w-0 truncate">{a.filename}</span>
                          <span className="shrink-0 text-muted">
                            {formatBytes(a.size)}
                            {!a.processed && ' · ignored, not a PDF'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                <Section title="Message">
                  {data.bodyText ? (
                    <pre className="rounded-panel border border-line bg-background p-3 font-sans break-words whitespace-pre-wrap">
                      {data.bodyText}
                    </pre>
                  ) : (
                    <p className="text-muted">
                      {data.provider === 'manual'
                        ? 'Uploaded by hand, so there is no email text.'
                        : 'No plain-text body.'}
                    </p>
                  )}
                </Section>

                {data.headers && data.headers.length > 0 && (
                  <details>
                    <summary className="cursor-pointer rounded-control text-muted outline-none hover:text-foreground focus-visible:focus-ring">
                      Headers ({data.headers.length})
                    </summary>
                    <dl className="mt-2 space-y-1 font-mono text-xs break-all">
                      {data.headers.map(([name, value], i) => (
                        <div key={`${name}-${String(i)}`}>
                          <dt className="inline font-semibold">{name}: </dt>
                          <dd className="inline text-muted">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </div>
            )}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
