import { type BankDetails, type ExtractedInvoice, vendorKey } from '@camex/shared';

// Scoring for `pnpm eval:extraction` (T03 §7): golden file vs normalized extraction.

export type ScoreRule = 'exact' | 'set' | 'decimal' | 'name' | 'count';

export interface FieldDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface Mismatch extends FieldDiff {
  rule: ScoreRule;
}

export interface Score {
  mismatches: Mismatch[];
  /** Printed side by side for a human; never fails the eval. */
  unscored: FieldDiff[];
}

const EXACT_FIELDS = [
  'documentType',
  'invoiceNumber',
  'invoiceDate',
  'serviceDate',
  'dueDate',
  'paymentTermsDays',
  'disputeWindowDays',
  'category',
  'airportIcao',
  'airportIata',
  'aircraftRegistration',
  'currency',
  'amountDueCurrency',
  'vendorTaxId',
] as const satisfies readonly (keyof ExtractedInvoice)[];

const DECIMAL_FIELDS = [
  'subtotalAmount',
  'taxAmount',
  'totalAmount',
  'amountDue',
] as const satisfies readonly (keyof ExtractedInvoice)[];

const NAME_FIELDS = [
  'vendorName',
  'billToName',
] as const satisfies readonly (keyof ExtractedInvoice)[];

const UNSCORED_FIELDS = [
  'description',
  'notes',
  'paymentTermsText',
  'locationText',
] as const satisfies readonly (keyof ExtractedInvoice)[];

const BANK_EXACT_FIELDS = [
  'iban',
  'accountNumber',
  'swift',
  'routingNumber',
  'currency',
] as const satisfies readonly (keyof BankDetails)[];

const NO_BANK_DETAILS: BankDetails = {
  beneficiary: null,
  bankName: null,
  iban: null,
  accountNumber: null,
  swift: null,
  routingNumber: null,
  currency: null,
};

/** "1334.590" → "1334.59", "-0.0" → "0"; null if not a plain decimal. */
function canonicalDecimal(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const sign = integer === '0' && fraction === '' ? '' : (match[1] ?? '');
  return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

/** Numeric equality on decimal strings, without floats. */
export function decimalEquals(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  return (canonicalDecimal(expected) ?? expected) === (canonicalDecimal(actual) ?? actual);
}

/** Equal vendorKeys (the matcher's rule), or one key contains the other as whole words. */
export function namesMatch(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  const a = vendorKey(expected);
  const b = vendorKey(actual);
  if (a === '' || b === '') return a === b;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function lineSummary(line: ExtractedInvoice['lineItems'][number] | undefined): string | null {
  if (line === undefined) return null;
  const v = (value: string | null) => value ?? '∅';
  return `${line.kind} "${v(line.description)}" ${v(line.quantity)} ${v(line.uom)} × ${v(line.unitPrice)} = ${v(line.amount)}`;
}

function sameSet(expected: readonly string[], actual: readonly string[]): boolean {
  const a = [...new Set(expected)].sort();
  const b = [...new Set(actual)].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function scoreExtraction(expected: ExtractedInvoice, actual: ExtractedInvoice): Score {
  const mismatches: Mismatch[] = [];
  const unscored: FieldDiff[] = [];
  const check = (rule: ScoreRule, field: string, e: unknown, a: unknown, ok: boolean) => {
    if (!ok) mismatches.push({ rule, field, expected: e, actual: a });
  };

  for (const field of EXACT_FIELDS) {
    check('exact', field, expected[field], actual[field], expected[field] === actual[field]);
  }
  check(
    'set',
    'flightNumbers',
    expected.flightNumbers,
    actual.flightNumbers,
    sameSet(expected.flightNumbers, actual.flightNumbers),
  );
  for (const field of DECIMAL_FIELDS) {
    check(
      'decimal',
      field,
      expected[field],
      actual[field],
      decimalEquals(expected[field], actual[field]),
    );
  }
  for (const field of NAME_FIELDS) {
    check(
      'name',
      field,
      expected[field],
      actual[field],
      namesMatch(expected[field], actual[field]),
    );
  }
  for (const field of UNSCORED_FIELDS) {
    unscored.push({ field, expected: expected[field], actual: actual[field] });
  }

  // A missing bank block compares like one with every field empty.
  const eb = expected.bankDetails ?? NO_BANK_DETAILS;
  const ab = actual.bankDetails ?? NO_BANK_DETAILS;
  for (const field of BANK_EXACT_FIELDS) {
    check('exact', `bankDetails.${field}`, eb[field], ab[field], eb[field] === ab[field]);
  }
  check(
    'name',
    'bankDetails.bankName',
    eb.bankName,
    ab.bankName,
    namesMatch(eb.bankName, ab.bankName),
  );
  // No beneficiary printed means the issuer; naming the issuer explicitly is also right.
  const beneficiaryOk =
    namesMatch(eb.beneficiary, ab.beneficiary) ||
    (eb.beneficiary === null &&
      ab.beneficiary !== null &&
      namesMatch(expected.vendorName, ab.beneficiary));
  check('name', 'bankDetails.beneficiary', eb.beneficiary, ab.beneficiary, beneficiaryOk);

  if (expected.lineItems.length !== actual.lineItems.length) {
    check('count', 'lineItems.length', expected.lineItems.length, actual.lineItems.length, false);
    // Not compared line by line, but shown so the difference can be seen.
    const count = Math.max(expected.lineItems.length, actual.lineItems.length);
    for (let i = 0; i < count; i++) {
      unscored.push({
        field: `lineItems[${i}]`,
        expected: lineSummary(expected.lineItems[i]),
        actual: lineSummary(actual.lineItems[i]),
      });
    }
  } else {
    expected.lineItems.forEach((e, i) => {
      const a = actual.lineItems[i];
      if (a === undefined) return;
      for (const field of ['quantity', 'unitPrice', 'amount'] as const) {
        check(
          'decimal',
          `lineItems[${i}].${field}`,
          e[field],
          a[field],
          decimalEquals(e[field], a[field]),
        );
      }
      for (const field of ['description', 'kind', 'uom'] as const) {
        unscored.push({ field: `lineItems[${i}].${field}`, expected: e[field], actual: a[field] });
      }
    });
  }

  return { mismatches, unscored };
}
