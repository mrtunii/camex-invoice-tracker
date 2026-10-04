import type { InboxEmail } from '@camex/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UploadInvoicesDialog } from '@/components/upload-invoices-dialog';
import { appConfig } from '@/lib/config';
import { formatTimestamp } from '@/lib/format';
import { EmailSheet } from './email-sheet';
import { InboxAddress } from './inbox-address';
import { InvoiceChip } from './invoice-chip';
import { inboxQueryKey, useInbox } from './inbox-query';

function InboxRow({ email, onOpen }: { email: InboxEmail; onOpen: () => void }) {
  const ignored = email.attachments.filter((a) => !a.processed);
  return (
    <TableRow className="cursor-pointer align-top" onClick={onOpen}>
      <TableCell className="whitespace-nowrap">{formatTimestamp(email.receivedAt)}</TableCell>
      <TableCell className="max-w-48">
        <span className="block truncate font-mono text-[0.8125rem]" title={email.fromAddress ?? ''}>
          {email.fromAddress ?? '—'}
        </span>
        {email.provider === 'manual' && (
          <Badge variant="outline" className="mt-1">
            Manual upload
          </Badge>
        )}
      </TableCell>
      <TableCell className="max-w-60">
        {/* The whole row is clickable; this button makes it reachable by keyboard. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="block max-w-full truncate text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
          title={email.subject ?? undefined}
        >
          {email.subject ?? <span className="text-muted-foreground">(no subject)</span>}
        </button>
      </TableCell>
      <TableCell className="w-full min-w-64">
        {email.invoices.length === 0 ? (
          <span className="text-muted-foreground">No PDF</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {email.invoices.map((invoice) => (
              <InvoiceChip key={invoice.id} invoice={invoice} />
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="max-w-36 text-muted-foreground">
        {ignored.length === 0 ? (
          '—'
        ) : (
          <ul className="space-y-0.5">
            {ignored.map((a, i) => (
              <li
                key={`${a.filename}-${String(i)}`}
                className="truncate font-mono text-xs"
                title={`${a.filename} (${a.contentType})`}
              >
                {a.filename}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
    </TableRow>
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
            Every email received and every manual upload, newest first. Each PDF becomes an invoice;
            other attachments are ignored.
            {inboxAddress !== null && (
              <span className="mt-1.5 block">
                <InboxAddress address={inboxAddress} />
              </span>
            )}
          </>
        }
        actions={
          <UploadInvoicesDialog
            onUploaded={() => void queryClient.invalidateQueries({ queryKey: inboxQueryKey })}
          />
        }
      />

      {inbox.isError ? (
        <p className="text-destructive">{inbox.error.message}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Invoices</TableHead>
                <TableHead className="whitespace-normal">Ignored attachments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inbox.isPending ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Loading emails…
                  </TableCell>
                </TableRow>
              ) : emails.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-12 text-center whitespace-normal text-muted-foreground"
                  >
                    <p>Nothing received yet. Emailed invoices and uploads appear here.</p>
                    {inboxAddress !== null && (
                      <p className="mt-2">
                        <InboxAddress address={inboxAddress} />
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                emails.map((email) => (
                  <InboxRow key={email.id} email={email} onOpen={() => setOpenEmailId(email.id)} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {inbox.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void inbox.fetchNextPage()}
            disabled={inbox.isFetchingNextPage}
          >
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <EmailSheet emailId={openEmailId} onClose={() => setOpenEmailId(null)} />
    </div>
  );
}
