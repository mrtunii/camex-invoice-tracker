import type { InboxEmail } from '@camex/shared';
import { Button, Table } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { TableEmpty, TablePanel } from '@/components/table-panel';
import { TruncatedText } from '@/components/truncated-text';
import { UploadInvoicesDialog } from '@/components/upload-invoices-dialog';
import { appConfig } from '@/lib/config';
import { formatTimestamp } from '@/lib/format';
import { invoicesQueryKey } from '@/pages/invoices/invoices-query';
import { EmailDrawer } from './email-drawer';
import { InboxAddress } from './inbox-address';
import { inboxQueryKey, useInbox } from './inbox-query';
import { InvoiceLink } from './invoice-link';

function IgnoredAttachments({ email }: { email: InboxEmail }) {
  const ignored = email.attachments.filter((a) => !a.processed);
  if (ignored.length === 0) return <span className="text-muted">—</span>;
  return (
    <ul className="space-y-0.5 text-muted">
      {ignored.map((a, i) => (
        <li key={`${a.filename}-${String(i)}`}>
          <TruncatedText text={a.filename} />
        </li>
      ))}
    </ul>
  );
}

export function InboxPage() {
  const inbox = useInbox();
  const queryClient = useQueryClient();
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);
  const emails = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  const { inboxAddress } = appConfig;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbox"
        description={
          <>
            Every email received and every upload, newest first. Each PDF becomes an invoice; other
            attachments are ignored.
            {inboxAddress !== null && (
              <span className="mt-1 block">
                <InboxAddress address={inboxAddress} />
              </span>
            )}
          </>
        }
        action={
          <UploadInvoicesDialog
            onUploaded={() => {
              void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
              void queryClient.invalidateQueries({ queryKey: invoicesQueryKey });
            }}
          />
        }
      />

      {inbox.isError ? (
        <p className="text-danger">{inbox.error.message}</p>
      ) : (
        <TablePanel>
          {/* Fixed layout: long values truncate instead of widening the table. */}
          <Table.Content
            aria-label="Inbox"
            className="min-w-[52rem] table-fixed"
            onRowAction={(key) => setOpenEmailId(String(key))}
          >
            <Table.Header>
              <Table.Column className="w-[9.5rem]">Received</Table.Column>
              <Table.Column className="w-[13rem]">From</Table.Column>
              <Table.Column isRowHeader>Subject</Table.Column>
              <Table.Column className="w-[22rem]">Invoices</Table.Column>
              <Table.Column className="w-[9rem]">Ignored attachments</Table.Column>
            </Table.Header>
            <Table.Body
              items={emails}
              renderEmptyState={() => (
                <TableEmpty loading={inbox.isPending}>
                  <p>Nothing received yet. Emailed invoices and uploads appear here.</p>
                  {inboxAddress !== null && (
                    <p className="mt-2">
                      <InboxAddress address={inboxAddress} />
                    </p>
                  )}
                </TableEmpty>
              )}
            >
              {(email) => (
                <Table.Row id={email.id} className="cursor-pointer align-top">
                  <Table.Cell className="tabular whitespace-nowrap">
                    {formatTimestamp(email.receivedAt)}
                  </Table.Cell>
                  <Table.Cell>
                    <TruncatedText text={email.fromAddress ?? '—'} />
                    {email.provider === 'manual' && (
                      <span className="block text-xs text-muted">Uploaded by hand</span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="font-medium">
                    {email.subject === null ? (
                      <span className="font-normal text-muted">(no subject)</span>
                    ) : (
                      <TruncatedText text={email.subject} />
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {email.invoices.length === 0 ? (
                      <span className="text-muted">No PDF</span>
                    ) : (
                      <ul className="space-y-1">
                        {email.invoices.map((invoice) => (
                          <li key={invoice.id}>
                            <InvoiceLink invoice={invoice} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <IgnoredAttachments email={email} />
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </TablePanel>
      )}

      {inbox.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onPress={() => void inbox.fetchNextPage()}
            isPending={inbox.isFetchingNextPage}
          >
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <EmailDrawer emailId={openEmailId} onClose={() => setOpenEmailId(null)} />
    </div>
  );
}
