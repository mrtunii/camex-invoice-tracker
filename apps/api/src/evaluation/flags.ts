import {
  type BankDetails,
  DISPUTE_SOON_DAYS,
  type DocumentType,
  type DueDateSource,
  type ExtractedLineItem,
  type ExtractionStatus,
  type FlagCode,
  type FlagSeverity,
  type InvoiceFlag,
  type InvoiceStatus,
  addDays,
  bankAccountKey,
  daysBetween,
  invoiceNumberKey,
  vendorKey,
} from '@camex/shared';
import { Prisma } from '../generated/prisma/client.js';

// SPEC §8 validation flags: deterministic code, no LLM. Pure: the evaluator gathers the input.

export const FLAG_SEVERITY: Record<FlagCode, FlagSeverity> = {
  EXTRACTION_FAILED: 'error',
  MISSING_REQUIRED: 'error',
  TOTAL_MATH: 'error',
  LINE_MATH: 'warning',
  DUE_BEFORE_INVOICE: 'error',
  TERMS_MISMATCH: 'warning',
  DUE_DATE_DERIVED: 'info',
  FUTURE_DATE: 'warning',
  SERVICE_AFTER_INVOICE: 'warning',
  PAY_IN_OTHER_CURRENCY: 'info',
  NOT_BILLED_TO_CAMEX: 'warning',
  NOT_AN_INVOICE: 'warning',
  DUPLICATE_FILE: 'error',
  DUPLICATE_NUMBER: 'error',
  NEW_VENDOR: 'info',
  BANK_FIRST_SEEN: 'warning',
  BANK_UNKNOWN: 'error',
  DISPUTE_SOON: 'warning',
};

const SEVERITY_RANK: Record<FlagSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The invoice fields the rules read, with the due date already derived. */
export interface FlagInvoice {
  id: string;
  status: InvoiceStatus;
  extractionStatus: ExtractionStatus;
  documentType: DocumentType | null;
  vendorId: string | null;
  vendorName: string | null;
  billToName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  serviceDate: string | null;
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  paymentTermsDays: number | null;
  disputeDeadline: string | null;
  currency: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  amountDue: string | null;
  amountDueCurrency: string | null;
  lineItems: readonly ExtractedLineItem[];
  bankDetails: BankDetails | null;
  fileSha256: string;
}

export interface FlagVendor {
  /** bankAccountKey of each active (not removed) trusted account. */
  trustedAccountKeys: readonly string[];
}

/** Another invoice sharing the file hash or the invoice number key, in any status. */
export interface DuplicateCandidate {
  id: string;
  status: InvoiceStatus;
  fileSha256: string;
  invoiceNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
}

export interface FlagInput {
  invoice: FlagInvoice;
  /** The linked vendor, or null (NEW_VENDOR). */
  vendor: FlagVendor | null;
  candidates: readonly DuplicateCandidate[];
}

/** Required for approval (SPEC §6), in form order. */
const REQUIRED_FIELDS = [
  ['vendorName', 'Vendor name'],
  ['invoiceNumber', 'Invoice number'],
  ['invoiceDate', 'Invoice date'],
  ['dueDate', 'Due date'],
  ['amountDue', 'Amount due'],
  ['amountDueCurrency', 'Currency of the amount due'],
] as const satisfies readonly (readonly [keyof FlagInvoice, string])[];

const NOT_AN_INVOICE_MESSAGES: Partial<Record<DocumentType, string>> = {
  proforma: 'This is a proforma invoice, not a payable invoice',
  statement: 'This is a statement, not an invoice',
  other: 'This document is not an invoice',
};

/** "Camex" in Latin and in Georgian script, compared lowercase. */
const CAMEX_NAMES = ['camex', 'კამექს'];

const MIN_TOLERANCE = new Prisma.Decimal('0.05');
/** 0.01 % */
const RELATIVE_TOLERANCE = new Prisma.Decimal('0.0001');

/** SPEC §8 money tolerance: |actual − expected| ≤ max(0.05, 0.01 % of expected). Decimal only. */
export function withinTolerance(actual: Prisma.Decimal, expected: Prisma.Decimal): boolean {
  const tolerance = Prisma.Decimal.max(MIN_TOLERANCE, expected.abs().times(RELATIVE_TOLERANCE));
  return actual.minus(expected).abs().lte(tolerance);
}

type AddFlag = (code: FlagCode, field: string | null, message: string) => void;

function isEmpty(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/** Money for messages: at least 2 decimals, more only if the value has them (100 → "100.00"). */
function money(value: Prisma.Decimal): string {
  return value.decimalPlaces() <= 2 ? value.toFixed(2) : value.toFixed();
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function others(n: number): string {
  return n === 1 ? 'another invoice' : `${n} other invoices`;
}

/** Same vendor for duplicates: same vendor_id, or equal vendorKey(vendor_name) when either is unlinked. */
function sameVendor(invoice: FlagInvoice, other: DuplicateCandidate): boolean {
  if (invoice.vendorId !== null && other.vendorId !== null) {
    return invoice.vendorId === other.vendorId;
  }
  const key = invoice.vendorName === null ? '' : vendorKey(invoice.vendorName);
  return key !== '' && other.vendorName !== null && vendorKey(other.vendorName) === key;
}

function amountFlags(invoice: FlagInvoice, add: AddFlag): void {
  const { lineItems, totalAmount, taxAmount } = invoice;
  // Like LINE_MATH, only with something to add up: lines without an amount add nothing.
  if (lineItems.some((line) => line.amount !== null) && totalAmount !== null) {
    const sum = lineItems.reduce(
      (acc, line) => (line.amount === null ? acc : acc.plus(line.amount)),
      new Prisma.Decimal(0),
    );
    const total = new Prisma.Decimal(totalAmount);
    const withTax = taxAmount === null ? null : sum.plus(taxAmount);
    const matches =
      withinTolerance(sum, total) || (withTax !== null && withinTolerance(withTax, total));
    if (!matches) {
      const sums =
        withTax === null || withTax.eq(sum)
          ? money(sum)
          : `${money(sum)} (${money(withTax)} with tax)`;
      add(
        'TOTAL_MATH',
        'totalAmount',
        `Line items add up to ${sums}, not the total of ${money(total)}`,
      );
    }
  }

  lineItems.forEach((line, index) => {
    if (line.quantity === null || line.unitPrice === null || line.amount === null) return;
    const product = new Prisma.Decimal(line.quantity).times(line.unitPrice);
    const amount = new Prisma.Decimal(line.amount);
    if (!withinTolerance(product, amount)) {
      add(
        'LINE_MATH',
        `lineItems.${index}.amount`,
        `Line ${index + 1}: quantity × unit price is ${product.toFixed(2)}, not ${money(amount)}`,
      );
    }
  });
}

function dateFlags(invoice: FlagInvoice, today: string, add: AddFlag): void {
  const { invoiceDate, dueDate, dueDateSource, serviceDate } = invoice;
  if (dueDate !== null && invoiceDate !== null && dueDate < invoiceDate) {
    add(
      'DUE_BEFORE_INVOICE',
      'dueDate',
      `Due date ${dueDate} is before the invoice date ${invoiceDate}`,
    );
  }
  if (
    dueDateSource === 'printed' &&
    invoice.paymentTermsDays !== null &&
    invoiceDate !== null &&
    dueDate !== null
  ) {
    const expected = addDays(invoiceDate, invoice.paymentTermsDays);
    if (expected !== dueDate) {
      add(
        'TERMS_MISMATCH',
        'dueDate',
        `Printed due date ${dueDate} doesn't match the ${days(invoice.paymentTermsDays)} terms (${expected})`,
      );
    }
  }
  if (
    (dueDateSource === 'terms' || dueDateSource === 'vendor_default') &&
    invoiceDate !== null &&
    dueDate !== null
  ) {
    const from = dueDateSource === 'terms' ? 'the payment terms' : "the vendor's default terms";
    add(
      'DUE_DATE_DERIVED',
      'dueDate',
      `Due date computed from ${from} (${days(daysBetween(invoiceDate, dueDate))})`,
    );
  }
  if (invoiceDate !== null && invoiceDate > today) {
    add('FUTURE_DATE', 'invoiceDate', `Invoice date ${invoiceDate} is in the future`);
  }
  if (serviceDate !== null && invoiceDate !== null && serviceDate > invoiceDate) {
    add(
      'SERVICE_AFTER_INVOICE',
      'serviceDate',
      `Service date ${serviceDate} is after the invoice date ${invoiceDate}`,
    );
  }
}

/**
 * SPEC §8 flags for one invoice: errors first, then warnings, then info; within a severity in
 * SPEC table order. None while the invoice is `processing`. `today` is the Tbilisi business day.
 */
export function computeFlags(input: FlagInput, today: string): InvoiceFlag[] {
  const { invoice, vendor } = input;
  if (invoice.status === 'processing') return [];

  const flags: InvoiceFlag[] = [];
  const add: AddFlag = (code, field, message) => {
    flags.push({ code, severity: FLAG_SEVERITY[code], field, message });
  };

  if (invoice.extractionStatus === 'failed') {
    add('EXTRACTION_FAILED', null, 'Extraction failed: enter the data from the PDF by hand');
  }
  for (const [field, label] of REQUIRED_FIELDS) {
    if (isEmpty(invoice[field])) add('MISSING_REQUIRED', field, `${label} is missing`);
  }
  amountFlags(invoice, add);
  dateFlags(invoice, today, add);

  if (
    invoice.currency !== null &&
    invoice.amountDueCurrency !== null &&
    invoice.currency !== invoice.amountDueCurrency
  ) {
    add(
      'PAY_IN_OTHER_CURRENCY',
      'amountDueCurrency',
      `Payable in ${invoice.amountDueCurrency}; the invoice is priced in ${invoice.currency}`,
    );
  }
  const billTo = invoice.billToName;
  if (billTo === null || isEmpty(billTo)) {
    add('NOT_BILLED_TO_CAMEX', 'billToName', 'No bill-to name found');
  } else if (!CAMEX_NAMES.some((name) => billTo.toLowerCase().includes(name))) {
    add('NOT_BILLED_TO_CAMEX', 'billToName', `Billed to "${billTo}", not Camex`);
  }
  const notInvoice =
    invoice.documentType === null ? undefined : NOT_AN_INVOICE_MESSAGES[invoice.documentType];
  if (notInvoice !== undefined) add('NOT_AN_INVOICE', 'documentType', notInvoice);

  const live = input.candidates.filter((c) => c.id !== invoice.id && c.status !== 'rejected');
  const sameFile = live.filter((c) => c.fileSha256 === invoice.fileSha256);
  if (sameFile.length > 0) {
    add('DUPLICATE_FILE', null, `The same PDF is also on ${others(sameFile.length)}`);
  }
  const numberKey = invoice.invoiceNumber === null ? '' : invoiceNumberKey(invoice.invoiceNumber);
  if (numberKey !== '') {
    const sameNumber = live.filter(
      (c) =>
        c.invoiceNumber !== null &&
        invoiceNumberKey(c.invoiceNumber) === numberKey &&
        sameVendor(invoice, c),
    );
    if (sameNumber.length > 0) {
      add(
        'DUPLICATE_NUMBER',
        'invoiceNumber',
        `Invoice number ${invoice.invoiceNumber ?? ''} from this vendor is also on ${others(sameNumber.length)}`,
      );
    }
  }

  if (vendor === null) {
    add('NEW_VENDOR', 'vendorName', 'No vendor matched: link an existing vendor or create one');
  } else {
    const key = bankAccountKey(invoice.bankDetails);
    if (key !== null) {
      const field =
        bankAccountKey({ iban: invoice.bankDetails?.iban ?? null, accountNumber: null }) === null
          ? 'bankDetails.accountNumber'
          : 'bankDetails.iban';
      if (vendor.trustedAccountKeys.length === 0) {
        add(
          'BANK_FIRST_SEEN',
          field,
          'First bank details seen for this vendor: verify them before trusting them',
        );
      } else if (!vendor.trustedAccountKeys.includes(key)) {
        add(
          'BANK_UNKNOWN',
          field,
          'Bank details differ from the ones on file: verify by phone with the vendor before paying',
        );
      }
    }
  }

  const deadline = invoice.disputeDeadline;
  if (
    invoice.status === 'needs_review' &&
    deadline !== null &&
    daysBetween(today, deadline) <= DISPUTE_SOON_DAYS
  ) {
    add(
      'DISPUTE_SOON',
      'disputeDeadline',
      deadline < today ? `Dispute window ended ${deadline}` : `Dispute window ends ${deadline}`,
    );
  }

  // Stable: within a severity the SPEC order above is kept.
  return flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
