// The review form's values and how they map to the API (T06 §2). Pure: no `@/` imports, so
// Node's test runner can load it (form-model.test.ts). Fields are validated and normalized with
// the API's own schemas from @camex/shared, so "4lcmx" and "4L-CMX" are the same value here too.
import {
  type BankDetails,
  type DocumentType,
  EDITABLE_FIELDS,
  type EditableField,
  type ExtractedInvoice,
  type InvoiceCategory,
  type InvoiceDetail,
  type LineItemKind,
  type UpdateInvoiceRequest,
  invoiceEditShape,
} from '@camex/shared';

export interface LineItemValues {
  kind: LineItemKind;
  description: string;
  quantity: string;
  uom: string;
  unitPrice: string;
  amount: string;
}

export type BankValues = Record<keyof BankDetails, string>;

/** Everything is text in the form; '' is empty. */
export interface InvoiceFormValues {
  documentType: DocumentType | '';
  vendorName: string;
  vendorTaxId: string;
  billToName: string;
  invoiceNumber: string;
  invoiceDate: string;
  serviceDate: string;
  dueDate: string;
  paymentTermsText: string;
  paymentTermsDays: string;
  disputeWindowDays: string;
  category: InvoiceCategory | '';
  description: string;
  airportIcao: string;
  airportIata: string;
  locationText: string;
  aircraftRegistration: string;
  /** Comma- or space-separated. */
  flightNumbers: string;
  currency: string;
  subtotalAmount: string;
  taxAmount: string;
  totalAmount: string;
  amountDue: string;
  amountDueCurrency: string;
  lineItems: LineItemValues[];
  bankDetails: BankValues;
  notes: string;
}

/** The editable fields of an invoice, or of its extraction (same names, same shapes). */
export type EditableValues = Pick<InvoiceDetail, EditableField> | ExtractedInvoice;

const text = (value: string | null) => value ?? '';

/** An amount with at least 2 decimals, as people write money ("2298.5" → "2298.50"); no float. */
function money(value: string | null): string {
  if (value === null) return '';
  const [whole = '', fraction = ''] = value.split('.');
  return fraction.length >= 2 ? value : `${whole}.${fraction.padEnd(2, '0')}`;
}

export const EMPTY_BANK: BankValues = {
  beneficiary: '',
  bankName: '',
  iban: '',
  accountNumber: '',
  swift: '',
  routingNumber: '',
  currency: '',
};

export function emptyLine(kind: LineItemKind = 'item'): LineItemValues {
  return { kind, description: '', quantity: '', uom: '', unitPrice: '', amount: '' };
}

export function toFormValues(invoice: EditableValues): InvoiceFormValues {
  const bank = invoice.bankDetails;
  return {
    documentType: invoice.documentType ?? '',
    vendorName: text(invoice.vendorName),
    vendorTaxId: text(invoice.vendorTaxId),
    billToName: text(invoice.billToName),
    invoiceNumber: text(invoice.invoiceNumber),
    invoiceDate: text(invoice.invoiceDate),
    serviceDate: text(invoice.serviceDate),
    dueDate: text(invoice.dueDate),
    paymentTermsText: text(invoice.paymentTermsText),
    paymentTermsDays: invoice.paymentTermsDays === null ? '' : String(invoice.paymentTermsDays),
    disputeWindowDays: invoice.disputeWindowDays === null ? '' : String(invoice.disputeWindowDays),
    category: invoice.category ?? '',
    description: text(invoice.description),
    airportIcao: text(invoice.airportIcao),
    airportIata: text(invoice.airportIata),
    locationText: text(invoice.locationText),
    aircraftRegistration: text(invoice.aircraftRegistration),
    flightNumbers: invoice.flightNumbers.join(', '),
    currency: text(invoice.currency),
    subtotalAmount: money(invoice.subtotalAmount),
    taxAmount: money(invoice.taxAmount),
    totalAmount: money(invoice.totalAmount),
    amountDue: money(invoice.amountDue),
    amountDueCurrency: text(invoice.amountDueCurrency),
    lineItems: invoice.lineItems.map((line) => ({
      kind: line.kind,
      description: text(line.description),
      quantity: text(line.quantity),
      uom: text(line.uom),
      unitPrice: text(line.unitPrice),
      amount: money(line.amount),
    })),
    bankDetails:
      bank === null
        ? { ...EMPTY_BANK }
        : {
            beneficiary: text(bank.beneficiary),
            bankName: text(bank.bankName),
            iban: text(bank.iban),
            accountNumber: text(bank.accountNumber),
            swift: text(bank.swift),
            routingNumber: text(bank.routingNumber),
            currency: text(bank.currency),
          },
    notes: text(invoice.notes),
  };
}

/** A form value as the API takes it (before validation). */
function rawInput(field: EditableField, values: InvoiceFormValues): unknown {
  switch (field) {
    case 'documentType':
    case 'category':
      return values[field] === '' ? null : values[field];
    case 'paymentTermsDays':
    case 'disputeWindowDays': {
      const typed = values[field].trim();
      // Anything else goes through as text, so the schema says what is wrong with it.
      return typed === '' ? null : /^\d+$/.test(typed) ? Number(typed) : typed;
    }
    case 'flightNumbers':
      return values.flightNumbers.split(/[\s,;]+/).filter((flight) => flight !== '');
    case 'lineItems':
      // Rows left completely empty are dropped.
      return values.lineItems.filter(
        (line) =>
          line.description.trim() !== '' ||
          line.quantity.trim() !== '' ||
          line.uom.trim() !== '' ||
          line.unitPrice.trim() !== '' ||
          line.amount.trim() !== '',
      );
    default:
      return values[field];
  }
}

export interface FieldIssue {
  /** The form path: `amountDue`, `lineItems.1.amount`, `bankDetails.iban`. */
  path: string;
  message: string;
}

export type FieldReading =
  { ok: true; value: UpdateInvoiceRequest[EditableField] } | { ok: false; issues: FieldIssue[] };

/** One field, validated and normalized with the API's schema. */
export function readField(field: EditableField, values: InvoiceFormValues): FieldReading {
  const result = invoiceEditShape[field].safeParse(rawInput(field, values));
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: [field, ...issue.path.map(String)].join('.'),
      message: issue.message,
    })),
  };
}

/** A decimal by its value: "2298.50", "2298.5" and "02298.500" are the same amount. */
function canonicalDecimal(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = fraction.replace(/0+$/, '');
  const result = f === '' ? w : `${w}.${f}`;
  return negative && result !== '0' ? `-${result}` : result;
}

const DECIMAL_FIELDS = new Set<EditableField>([
  'subtotalAmount',
  'taxAmount',
  'totalAmount',
  'amountDue',
]);

/** A field's value for comparing: amounts by their numeric value (the API stores numeric). */
function comparable(field: EditableField, value: unknown): unknown {
  if (typeof value === 'string' && DECIMAL_FIELDS.has(field)) return canonicalDecimal(value);
  if (field === 'lineItems' && Array.isArray(value)) {
    return value.map((line: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...line };
      for (const key of ['quantity', 'unitPrice', 'amount']) {
        if (typeof out[key] === 'string') out[key] = canonicalDecimal(out[key]);
      }
      return out;
    });
  }
  return value;
}

/** Whether two values of `field` are the same (amounts compared by value). */
export function sameFieldValue(field: EditableField, a: unknown, b: unknown): boolean {
  return sameValue(comparable(field, a), comparable(field, b));
}

/** Deep equality for JSON-like values, regardless of key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((key) => sameValue(x[key] ?? null, y[key] ?? null));
}

export interface FormDiff {
  /** Fields whose (normalized) value differs from the saved invoice, or that can't be read. */
  dirty: EditableField[];
  /** The PATCH body's fields: only the changed, valid ones. */
  changes: Partial<UpdateInvoiceRequest>;
  issues: FieldIssue[];
}

/** What a save would send: the fields that changed, normalized; plus what blocks it. */
export function diffForm(values: InvoiceFormValues, saved: EditableValues): FormDiff {
  const dirty: EditableField[] = [];
  const changes: Record<string, unknown> = {};
  const issues: FieldIssue[] = [];
  for (const field of EDITABLE_FIELDS) {
    const reading = readField(field, values);
    if (!reading.ok) {
      dirty.push(field);
      issues.push(...reading.issues);
    } else if (!sameFieldValue(field, reading.value, saved[field])) {
      dirty.push(field);
      changes[field] = reading.value;
    }
  }
  return { dirty, changes, issues };
}

/**
 * Whether a field's value in the form differs from what the model read (the "Extracted: …"
 * hint). The due date only counts when a person set it: a date derived from the terms isn't an
 * edit, whatever the PDF printed.
 */
export function differsFromExtraction(
  field: EditableField,
  values: InvoiceFormValues,
  extracted: ExtractedInvoice,
  saved: Pick<InvoiceDetail, 'dueDate' | 'dueDateSource'>,
): boolean {
  const reading = readField(field, values);
  if (!reading.ok) return true;
  if (field === 'dueDate') {
    const touched = saved.dueDateSource === 'manual' || reading.value !== saved.dueDate;
    return touched && reading.value !== extracted.dueDate;
  }
  return !sameFieldValue(field, reading.value, extracted[field]);
}

/** Same for one bank detail (its own "Extracted: …" hint). */
export function bankFieldDiffers(
  key: keyof BankDetails,
  values: InvoiceFormValues,
  extracted: ExtractedInvoice,
): boolean {
  const reading = invoiceEditShape.bankDetails.safeParse(rawInput('bankDetails', values));
  if (!reading.success) return true;
  return (reading.data?.[key] ?? null) !== (extracted.bankDetails?.[key] ?? null);
}
