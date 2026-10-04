import type { BankDetails, EditableField, InvoiceDetail } from '@camex/shared';
import { cn } from '@heroui/react';
import type { ReactNode } from 'react';
import { formatFieldValue } from '@/lib/activity';
import { formatDate, formatMoney } from '@/lib/format';
import { BANK_FIELD_LABELS, FIELD_LABELS, LINE_KIND_LABELS } from '@/lib/invoice-labels';
import { fieldDomId } from './field-focus';
import { toFormValues } from './form-model';
import { LineTotalsLine } from './line-items-editor';

function Fact({
  path,
  label,
  children,
  mono,
  tabular,
}: {
  path: string;
  label: string;
  children: ReactNode;
  mono?: boolean;
  tabular?: boolean;
}) {
  const empty = children === '—';
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd
        id={fieldDomId(path)}
        tabIndex={-1}
        className={cn(
          'min-w-0 rounded-control break-words outline-none focus-visible:focus-ring',
          mono && !empty && 'font-mono',
          tabular && 'tabular',
          empty && 'text-muted',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{title}</h3>
      <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-6 gap-y-2">{children}</dl>
    </section>
  );
}

const MONO = new Set<string>([
  'invoiceNumber',
  'aircraftRegistration',
  'flightNumbers',
  'vendorTaxId',
]);

/**
 * The invoice's data as text, for every status but needs_review (fields are editable only there):
 * the same sections and order as the review form.
 */
export function InvoiceFacts({ invoice }: { invoice: InvoiceDetail }) {
  const fact = (field: Exclude<EditableField, 'lineItems' | 'bankDetails'>, tabular = false) => (
    <Fact path={field} label={FIELD_LABELS[field]} mono={MONO.has(field)} tabular={tabular}>
      {formatFieldValue(field, invoice[field])}
    </Fact>
  );
  const bank = (key: keyof BankDetails) => (
    <Fact
      path={`bankDetails.${key}`}
      label={BANK_FIELD_LABELS[key]}
      mono={key !== 'beneficiary' && key !== 'bankName' && key !== 'currency'}
    >
      {invoice.bankDetails?.[key] ?? '—'}
    </Fact>
  );

  return (
    <div className="space-y-8">
      <Section title="Summary">
        {fact('vendorName')}
        {fact('invoiceNumber')}
        {fact('documentType')}
        {fact('category')}
        {fact('billToName')}
        {fact('vendorTaxId')}
        {fact('description')}
      </Section>
      <Section title="Amounts">
        {fact('currency')}
        {fact('subtotalAmount', true)}
        {fact('taxAmount', true)}
        {fact('totalAmount', true)}
        {fact('amountDue', true)}
        {fact('amountDueCurrency')}
      </Section>
      <Section title="Dates & terms">
        {fact('invoiceDate', true)}
        {fact('serviceDate', true)}
        {fact('dueDate', true)}
        {fact('paymentTermsText')}
        {fact('paymentTermsDays')}
        <Fact path="disputeWindowDays" label="Dispute window">
          {invoice.disputeWindowDays === null
            ? '—'
            : `${formatFieldValue('disputeWindowDays', invoice.disputeWindowDays)}${
                invoice.disputeDeadline === null
                  ? ''
                  : `, until ${formatDate(invoice.disputeDeadline)}`
              }`}
        </Fact>
      </Section>
      {invoice.bankDetails === null ? (
        <section className="space-y-3">
          <h3 className="text-base font-semibold">Bank details</h3>
          <p className="text-muted">No bank details on the invoice.</p>
        </section>
      ) : (
        <Section title="Bank details">
          {bank('beneficiary')}
          {bank('bankName')}
          {bank('iban')}
          {bank('accountNumber')}
          {bank('swift')}
          {bank('routingNumber')}
          {bank('currency')}
        </Section>
      )}

      <section className="space-y-3" id={fieldDomId('lineItems')}>
        <h3 className="text-base font-semibold">Line items</h3>
        {invoice.lineItems.length === 0 ? (
          <p className="text-muted">No lines.</p>
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line">
            <table className="w-full min-w-[26rem] text-sm">
              <thead className="bg-surface-secondary text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-end font-medium">Quantity</th>
                  <th className="px-3 py-2 text-end font-medium">Unit price</th>
                  <th className="px-3 py-2 text-end font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((line, i) => (
                  <tr
                    key={`${String(i)}-${line.description ?? ''}`}
                    id={fieldDomId(`lineItems.${String(i)}.amount`)}
                    className="border-t border-line"
                  >
                    <td className="px-3 py-2">
                      {line.kind !== 'item' && (
                        <span className="text-muted">{LINE_KIND_LABELS[line.kind]}: </span>
                      )}
                      {line.description ?? <span className="text-muted">No description</span>}
                    </td>
                    <td className="tabular px-3 py-2 text-end whitespace-nowrap">
                      {line.quantity === null ? '—' : `${line.quantity} ${line.uom ?? ''}`}
                    </td>
                    <td className="tabular px-3 py-2 text-end">{line.unitPrice ?? '—'}</td>
                    <td className="tabular px-3 py-2 text-end">
                      {line.amount === null ? '—' : formatMoney(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <LineTotalsLine values={toFormValues(invoice)} />
      </section>

      <Section title="Operation">
        {fact('airportIcao')}
        {fact('airportIata')}
        {fact('locationText')}
        {fact('aircraftRegistration')}
        {fact('flightNumbers')}
      </Section>
      <section className="space-y-3">
        <h3 className="text-base font-semibold">Notes</h3>
        <p
          id={fieldDomId('notes')}
          tabIndex={-1}
          className={cn(
            'break-words whitespace-pre-line outline-none',
            invoice.notes === null && 'text-muted',
          )}
        >
          {invoice.notes ?? 'No notes.'}
        </p>
      </section>
    </div>
  );
}
