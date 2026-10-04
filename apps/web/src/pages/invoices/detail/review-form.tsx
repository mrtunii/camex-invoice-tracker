import {
  type BankDetails,
  type EditableField,
  type InvoiceDetail,
  daysBetween,
  documentTypeSchema,
  invoiceCategorySchema,
} from '@camex/shared';
import type { ReactNode } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { formatFieldValue } from '@/lib/activity';
import { formatDate, plural } from '@/lib/format';
import {
  BANK_FIELD_LABELS,
  CATEGORY_LABELS,
  DOCUMENT_TYPE_LABELS,
  FIELD_LABELS,
} from '@/lib/invoice-labels';
import {
  DateInputField,
  ExtractedHint,
  SelectField,
  TextAreaField,
  TextInputField,
} from './form-fields';
import {
  type InvoiceFormValues,
  bankFieldDiffers,
  differsFromExtraction,
  toFormValues,
} from './form-model';
import { LineItemsEditor } from './line-items-editor';

const DOCUMENT_TYPE_OPTIONS = documentTypeSchema.options.map((id) => ({
  id,
  label: DOCUMENT_TYPE_LABELS[id],
}));
const CATEGORY_OPTIONS = invoiceCategorySchema.options.map((id) => ({
  id,
  label: CATEGORY_LABELS[id],
}));

const MONO_FIELDS = new Set<EditableField>([
  'invoiceNumber',
  'aircraftRegistration',
  'flightNumbers',
]);
const MONO_BANK = new Set<keyof BankDetails>(['iban', 'accountNumber', 'swift', 'routingNumber']);

export function FormSection({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  /** One column (line items, notes). */
  wide?: boolean;
}) {
  const id = `section-${title.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      <div className={wide ? 'space-y-4' : 'grid gap-x-4 gap-y-4 sm:grid-cols-2'}>{children}</div>
    </section>
  );
}

/** How the due date came about, when it wasn't printed or typed. */
function derivationHint(invoice: InvoiceDetail): string | null {
  const { dueDate, invoiceDate, dueDateSource } = invoice;
  if (dueDate === null || invoiceDate === null) return null;
  const days = plural(daysBetween(invoiceDate, dueDate), 'day', 'days');
  if (dueDateSource === 'terms') return `Worked out from the payment terms (${days})`;
  if (dueDateSource === 'vendor_default') {
    return `Worked out from ${invoice.vendor?.name ?? 'the vendor'}’s default terms (${days})`;
  }
  return null;
}

/**
 * The extracted data, editable (needs_review only), in review order: summary, amounts, dates and
 * terms, bank details, line items, operation, notes. A field that differs from the model's reading
 * says what was read, with Restore.
 */
export function ReviewForm({
  form,
  invoice,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  invoice: InvoiceDetail;
}) {
  const { control, setValue } = form;
  const values = useWatch({ control }) as InvoiceFormValues;
  const { extracted } = invoice;
  const extractedValues = extracted === null ? null : toFormValues(extracted);

  function hint(field: Exclude<EditableField, 'lineItems' | 'bankDetails'>): ReactNode {
    if (extracted === null || extractedValues === null) return undefined;
    if (!differsFromExtraction(field, values, extracted, invoice)) return undefined;
    return (
      <ExtractedHint
        value={formatFieldValue(field, extracted[field])}
        mono={MONO_FIELDS.has(field)}
        onRestore={() =>
          setValue(field, extractedValues[field], { shouldDirty: true, shouldValidate: false })
        }
      />
    );
  }

  function bankHint(key: keyof BankDetails): ReactNode {
    if (extracted === null || extractedValues === null) return undefined;
    if (!bankFieldDiffers(key, values, extracted)) return undefined;
    return (
      <ExtractedHint
        value={extracted.bankDetails?.[key] ?? '—'}
        mono={MONO_BANK.has(key)}
        onRestore={() =>
          setValue(`bankDetails.${key}`, extractedValues.bankDetails[key], { shouldDirty: true })
        }
      />
    );
  }

  const text = (
    name: Exclude<
      EditableField,
      | 'lineItems'
      | 'bankDetails'
      | 'documentType'
      | 'category'
      | 'invoiceDate'
      | 'serviceDate'
      | 'dueDate'
      | 'notes'
    >,
    options: { mono?: boolean; numeric?: boolean; uppercase?: boolean; className?: string } = {},
  ) => (
    <TextInputField
      control={control}
      name={name}
      label={FIELD_LABELS[name]}
      hint={hint(name)}
      {...options}
    />
  );

  const bank = (key: keyof BankDetails, className?: string) => (
    <TextInputField
      control={control}
      name={`bankDetails.${key}`}
      label={BANK_FIELD_LABELS[key]}
      hint={bankHint(key)}
      mono={MONO_BANK.has(key)}
      uppercase={key === 'currency'}
      className={className}
    />
  );

  // A derived date says how it was worked out, until someone changes it.
  const derivation = values.dueDate === invoice.dueDate ? derivationHint(invoice) : null;
  const dueHint = hint('dueDate');
  const dueDateHint =
    derivation !== null || dueHint !== undefined ? (
      <span className="flex flex-col gap-0.5">
        {derivation !== null && <span>{derivation}</span>}
        {dueHint}
      </span>
    ) : undefined;
  const disputeEnds =
    invoice.disputeDeadline === null ? null : `Ends ${formatDate(invoice.disputeDeadline)}`;

  return (
    <div className="space-y-8">
      <FormSection title="Summary">
        {text('vendorName', { className: 'sm:col-span-2' })}
        {text('invoiceNumber', { mono: true })}
        <SelectField
          control={control}
          name="documentType"
          label={FIELD_LABELS.documentType}
          options={DOCUMENT_TYPE_OPTIONS}
          hint={hint('documentType')}
        />
        <SelectField
          control={control}
          name="category"
          label={FIELD_LABELS.category}
          options={CATEGORY_OPTIONS}
          hint={hint('category')}
        />
        {text('billToName')}
        {text('vendorTaxId', { mono: true })}
        {text('description', { className: 'sm:col-span-2' })}
      </FormSection>

      <FormSection title="Amounts">
        {text('currency', { uppercase: true })}
        {text('subtotalAmount', { numeric: true })}
        {text('taxAmount', { numeric: true })}
        {text('totalAmount', { numeric: true })}
        {text('amountDue', { numeric: true })}
        {text('amountDueCurrency', { uppercase: true })}
      </FormSection>

      <FormSection title="Dates & terms">
        <DateInputField
          control={control}
          name="invoiceDate"
          label={FIELD_LABELS.invoiceDate}
          hint={hint('invoiceDate')}
        />
        <DateInputField
          control={control}
          name="serviceDate"
          label={FIELD_LABELS.serviceDate}
          hint={hint('serviceDate')}
        />
        <DateInputField
          control={control}
          name="dueDate"
          label={FIELD_LABELS.dueDate}
          hint={dueDateHint}
        />
        {text('paymentTermsText')}
        {text('paymentTermsDays', { numeric: true })}
        <TextInputField
          control={control}
          name="disputeWindowDays"
          label="Dispute window (days)"
          numeric
          hint={hint('disputeWindowDays') ?? disputeEnds ?? undefined}
        />
      </FormSection>

      <FormSection title="Bank details">
        {bank('beneficiary', 'sm:col-span-2')}
        {bank('bankName', 'sm:col-span-2')}
        {bank('iban', 'sm:col-span-2')}
        {bank('accountNumber')}
        {bank('swift')}
        {bank('routingNumber')}
        {bank('currency')}
      </FormSection>

      <LineItemsEditor form={form} invoice={invoice} />

      <FormSection title="Operation">
        {text('airportIcao', { uppercase: true })}
        {text('airportIata', { uppercase: true })}
        {text('locationText', { className: 'sm:col-span-2' })}
        {text('aircraftRegistration', { mono: true, uppercase: true })}
        {text('flightNumbers', { mono: true, uppercase: true })}
      </FormSection>

      <FormSection title="Notes" wide>
        {/* The section heading says "Notes"; the label is for screen readers only. */}
        <TextAreaField
          control={control}
          name="notes"
          label={<span className="sr-only">Notes</span>}
          hint={hint('notes')}
        />
      </FormSection>
    </div>
  );
}
