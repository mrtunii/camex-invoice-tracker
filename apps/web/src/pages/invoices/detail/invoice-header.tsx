import type { InvoiceDetail } from '@camex/shared';
import { Button, Modal } from '@heroui/react';
import { useState } from 'react';
import { StatusWord } from '@/components/status-word';
import { ToneText } from '@/components/tone';
import { formatMoney } from '@/lib/format';
import { stateLine } from './state-line';
import { VendorLinker } from './vendor-linker';

/**
 * Who, which invoice, how much, and where it stands. An unmatched vendor shows the extracted
 * name with a quiet "Link vendor" (to review only).
 */
export function InvoiceHeader({
  invoice,
  today,
  onChange,
  onStale,
}: {
  invoice: InvoiceDetail;
  today: string;
  /** The invoice after linking a vendor here. */
  onChange: (invoice: InvoiceDetail) => void;
  onStale: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const vendorName = invoice.vendor?.name ?? invoice.vendorName;
  const canLink = invoice.status === 'needs_review' && invoice.vendor === null;
  const amount = invoice.amountDue;
  const state = stateLine(invoice, today);

  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="min-w-0 text-xl font-semibold break-words">
          {vendorName ?? (
            <span className="text-muted">
              {invoice.status === 'processing' ? 'Reading the PDF…' : 'Vendor not known'}
            </span>
          )}
        </h1>
        {canLink && (
          <Button size="sm" variant="ghost" onPress={() => setLinking(true)}>
            Link vendor
          </Button>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {invoice.invoiceNumber !== null && (
          <span className="font-mono break-all">{invoice.invoiceNumber}</span>
        )}
        <StatusWord status={invoice.status} />
      </p>
      <p className="tabular text-3xl font-semibold">
        {amount === null ? (
          <span className="text-xl font-normal text-muted">No amount yet</span>
        ) : (
          <>
            {formatMoney(amount)}
            {invoice.amountDueCurrency !== null && (
              <span className="text-xl font-normal text-muted"> {invoice.amountDueCurrency}</span>
            )}
          </>
        )}
      </p>
      {state.length > 0 && (
        <p className="text-sm">
          {state.map((part, i) => (
            <span key={part.text}>
              {i > 0 && <span className="text-muted"> · </span>}
              <ToneText text={part.text} tone={part.tone} />
            </span>
          ))}
        </p>
      )}

      <Modal.Backdrop isOpen={linking} onOpenChange={setLinking}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Link a vendor</Modal.Heading>
              {invoice.vendorName !== null && (
                <p className="text-muted">The invoice says “{invoice.vendorName}”.</p>
              )}
            </Modal.Header>
            <Modal.Body className="pb-6">
              <VendorLinker
                invoice={invoice}
                onLinked={(linked) => {
                  setLinking(false);
                  onChange(linked);
                }}
                onStale={() => {
                  setLinking(false);
                  onStale();
                }}
              />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </header>
  );
}
