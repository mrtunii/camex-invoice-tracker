import {
  type BankDetails,
  type ExtractedLineItem,
  type FlagCode,
  type InvoiceFlag,
  bankAccountKey,
} from '@camex/shared';
import { describe, expect, it } from 'vitest';
import { deriveDates } from '../src/evaluation/derive-dates.js';
import {
  type DuplicateCandidate,
  type FlagInput,
  type FlagInvoice,
  computeFlags,
} from '../src/evaluation/flags.js';
import { expectedExtraction } from './helpers.js';

const TODAY = '2026-10-02';
const IBAN = 'GE00TB0000000000000001';

const LINE: ExtractedLineItem = {
  kind: 'item',
  description: 'Fuel',
  quantity: '10',
  uom: 'USG',
  unitPrice: '10',
  amount: '100.00',
};
const BANK: BankDetails = {
  beneficiary: null,
  bankName: 'TBC Bank',
  iban: IBAN,
  accountNumber: null,
  swift: null,
  routingNumber: null,
  currency: 'USD',
};

/** An invoice that raises no flag: linked vendor with this account trusted, everything adds up. */
function clean(overrides: Partial<FlagInvoice> = {}): FlagInvoice {
  return {
    id: 'self',
    status: 'needs_review',
    extractionStatus: 'succeeded',
    documentType: 'invoice',
    vendorId: 'vendor-1',
    vendorName: 'Acme Fuel LLC',
    billToName: 'Camex Airlines LLC',
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-09-20',
    serviceDate: '2026-09-19',
    dueDate: '2026-10-20',
    dueDateSource: 'printed',
    paymentTermsDays: 30,
    disputeDeadline: null,
    currency: 'USD',
    totalAmount: '110.00',
    taxAmount: '10.00',
    amountDue: '110.00',
    amountDueCurrency: 'USD',
    lineItems: [LINE],
    bankDetails: BANK,
    fileSha256: 'sha-self',
    ...overrides,
  };
}

function flags(
  invoice: FlagInvoice,
  input: Partial<Omit<FlagInput, 'invoice'>> = {},
  today = TODAY,
) {
  return computeFlags(
    { invoice, vendor: { trustedAccountKeys: [IBAN] }, candidates: [], ...input },
    today,
  );
}

const codes = (list: InvoiceFlag[]) => list.map((flag) => flag.code);
const only = (list: InvoiceFlag[], code: FlagCode) => list.filter((flag) => flag.code === code);

/** One line whose quantity × unit price equals its amount, and a total equal to it. */
function singleLine(amount: string, product: string, total = amount): Partial<FlagInvoice> {
  return {
    taxAmount: null,
    totalAmount: total,
    amountDue: total,
    lineItems: [
      { kind: 'item', description: 'x', quantity: '1', uom: null, unitPrice: product, amount },
    ],
  };
}

function candidate(overrides: Partial<DuplicateCandidate>): DuplicateCandidate {
  return {
    id: 'other',
    status: 'needs_review',
    fileSha256: 'sha-other',
    invoiceNumber: 'OTHER-9',
    vendorId: 'vendor-1',
    vendorName: 'Acme Fuel LLC',
    ...overrides,
  };
}

describe('computeFlags', () => {
  it('a clean invoice has no flags', () => {
    expect(flags(clean())).toEqual([]);
  });

  it('no flags at all while processing', () => {
    expect(
      flags(clean({ status: 'processing', extractionStatus: 'pending', vendorName: null })),
    ).toEqual([]);
  });

  it('EXTRACTION_FAILED when the extraction failed', () => {
    expect(only(flags(clean({ extractionStatus: 'failed' })), 'EXTRACTION_FAILED')).toEqual([
      {
        code: 'EXTRACTION_FAILED',
        severity: 'error',
        field: null,
        message: 'Extraction failed: enter the data from the PDF by hand',
      },
    ]);
    expect(codes(flags(clean()))).not.toContain('EXTRACTION_FAILED');
  });

  it('MISSING_REQUIRED: one error per empty required field', () => {
    const list = flags(
      clean({
        vendorName: null,
        invoiceNumber: '  ',
        invoiceDate: null,
        dueDate: null,
        dueDateSource: null,
        amountDue: null,
        amountDueCurrency: null,
      }),
    );
    expect(only(list, 'MISSING_REQUIRED')).toEqual([
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'vendorName',
        message: 'Vendor name is missing',
      },
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'invoiceNumber',
        message: 'Invoice number is missing',
      },
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'invoiceDate',
        message: 'Invoice date is missing',
      },
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'dueDate',
        message: 'Due date is missing',
      },
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'amountDue',
        message: 'Amount due is missing',
      },
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'amountDueCurrency',
        message: 'Currency of the amount due is missing',
      },
    ]);
  });

  describe('TOTAL_MATH', () => {
    it('passes when the lines add up to the total, or to it with tax', () => {
      expect(codes(flags(clean()))).not.toContain('TOTAL_MATH'); // 100 + 10 tax = 110
      expect(codes(flags(clean({ taxAmount: '0', totalAmount: '100.00' })))).not.toContain(
        'TOTAL_MATH',
      );
      // A tax line among the items: the plain sum is the total.
      const withTaxLine = clean({
        lineItems: [
          ...clean().lineItems,
          {
            kind: 'tax',
            description: 'VAT',
            quantity: null,
            uom: null,
            unitPrice: null,
            amount: '10.00',
          },
        ],
      });
      expect(codes(flags(withTaxLine))).not.toContain('TOTAL_MATH');
    });

    it('fails when neither sum matches', () => {
      expect(only(flags(clean({ totalAmount: '120.00' })), 'TOTAL_MATH')).toEqual([
        {
          code: 'TOTAL_MATH',
          severity: 'error',
          field: 'totalAmount',
          message: 'Line items add up to 100.00 (110.00 with tax), not the total of 120.00',
        },
      ]);
      expect(
        only(flags(clean({ totalAmount: '120.00', taxAmount: null })), 'TOTAL_MATH')[0]?.message,
      ).toBe('Line items add up to 100.00, not the total of 120.00');
      expect(
        only(
          flags(
            clean({
              totalAmount: '120.5',
              taxAmount: null,
              lineItems: [{ ...LINE, amount: '100.1234', quantity: null }],
            }),
          ),
          'TOTAL_MATH',
        )[0]?.message,
      ).toBe('Line items add up to 100.1234, not the total of 120.50');
    });

    it('is skipped without line items or without a total', () => {
      expect(codes(flags(clean({ lineItems: [], totalAmount: '999' })))).not.toContain(
        'TOTAL_MATH',
      );
      expect(codes(flags(clean({ totalAmount: null })))).not.toContain('TOTAL_MATH');
    });

    it('is skipped when no line item has an amount (as LINE_MATH)', () => {
      const noAmounts = [
        { ...LINE, amount: null },
        { ...LINE, kind: 'fee' as const, quantity: null, unitPrice: null, amount: null },
      ];
      expect(codes(flags(clean({ lineItems: noAmounts, totalAmount: '999' })))).not.toContain(
        'TOTAL_MATH',
      );
      // One line with an amount is enough to check the sum.
      expect(
        codes(flags(clean({ lineItems: [...noAmounts, LINE], totalAmount: '999' }))),
      ).toContain('TOTAL_MATH');
    });

    it('tolerance: 0.05 absolute', () => {
      expect(codes(flags(clean(singleLine('100.05', '100.05', '100.00'))))).not.toContain(
        'TOTAL_MATH',
      );
      expect(codes(flags(clean(singleLine('99.95', '99.95', '100.00'))))).not.toContain(
        'TOTAL_MATH',
      );
      expect(codes(flags(clean(singleLine('100.06', '100.06', '100.00'))))).toContain('TOTAL_MATH');
    });

    it('tolerance: 0.01 % of the total when that is larger', () => {
      // 0.01 % of 1,000,000 = 100
      const total = '1000000.00';
      expect(codes(flags(clean(singleLine('1000100.00', '1000100.00', total))))).not.toContain(
        'TOTAL_MATH',
      );
      expect(codes(flags(clean(singleLine('1000100.01', '1000100.01', total))))).toContain(
        'TOTAL_MATH',
      );
      // On a credit note the total is negative: the tolerance uses its size.
      expect(
        codes(flags(clean(singleLine('-1000100.00', '-1000100.00', '-1000000.00')))),
      ).not.toContain('TOTAL_MATH');
    });

    it('uses exact decimals, not floats', () => {
      // 0.1 + 0.2 is 0.30000000000000004 in floats; with a 0.3 total and 0.05 tolerance that
      // still passes, so check the edge instead: 0.05 exactly.
      const invoice = clean({
        taxAmount: null,
        totalAmount: '0.35',
        amountDue: '0.35',
        lineItems: [
          {
            kind: 'item',
            description: 'a',
            quantity: null,
            uom: null,
            unitPrice: null,
            amount: '0.1',
          },
          {
            kind: 'item',
            description: 'b',
            quantity: null,
            uom: null,
            unitPrice: null,
            amount: '0.2',
          },
        ],
      });
      expect(codes(flags(invoice))).not.toContain('TOTAL_MATH');
    });
  });

  describe('LINE_MATH', () => {
    it('flags each line whose quantity × unit price is off, by its path', () => {
      const invoice = clean({
        taxAmount: null,
        totalAmount: '122.00',
        amountDue: '122.00',
        lineItems: [
          {
            kind: 'item',
            description: 'ok',
            quantity: '10',
            uom: 'USG',
            unitPrice: '10',
            amount: '100.00',
          },
          {
            kind: 'fee',
            description: 'off',
            quantity: '1.000',
            uom: 'QTY',
            unitPrice: '10.000000',
            amount: '12.00',
          },
          {
            kind: 'fee',
            description: 'no qty',
            quantity: null,
            uom: null,
            unitPrice: null,
            amount: '10.00',
          },
        ],
      });
      expect(only(flags(invoice), 'LINE_MATH')).toEqual([
        {
          code: 'LINE_MATH',
          severity: 'warning',
          field: 'lineItems.1.amount',
          message: 'Line 2: quantity × unit price is 10.00, not 12.00',
        },
      ]);
    });

    it('needs quantity, unit price and amount', () => {
      const partial = clean({
        lineItems: [
          {
            kind: 'item',
            description: 'x',
            quantity: '10',
            uom: null,
            unitPrice: null,
            amount: '100.00',
          },
        ],
      });
      expect(codes(flags(partial))).not.toContain('LINE_MATH');
    });

    it('tolerance against the line amount: 0.05, or 0.01 % when larger', () => {
      expect(codes(flags(clean(singleLine('100.00', '100.05'))))).not.toContain('LINE_MATH');
      expect(codes(flags(clean(singleLine('100.00', '100.06'))))).toContain('LINE_MATH');
      expect(codes(flags(clean(singleLine('1000000.00', '1000100'))))).not.toContain('LINE_MATH');
      expect(codes(flags(clean(singleLine('1000000.00', '1000100.01'))))).toContain('LINE_MATH');
    });
  });

  it('DUE_BEFORE_INVOICE when the due date is before the invoice date', () => {
    expect(
      only(flags(clean({ dueDate: '2026-09-19', paymentTermsDays: null })), 'DUE_BEFORE_INVOICE'),
    ).toEqual([
      {
        code: 'DUE_BEFORE_INVOICE',
        severity: 'error',
        field: 'dueDate',
        message: 'Due date 2026-09-19 is before the invoice date 2026-09-20',
      },
    ]);
    expect(codes(flags(clean({ dueDate: '2026-09-20', paymentTermsDays: 0 })))).not.toContain(
      'DUE_BEFORE_INVOICE',
    );
  });

  it('TERMS_MISMATCH only for a printed due date with terms', () => {
    expect(only(flags(clean({ paymentTermsDays: 7 })), 'TERMS_MISMATCH')).toEqual([
      {
        code: 'TERMS_MISMATCH',
        severity: 'warning',
        field: 'dueDate',
        message: "Printed due date 2026-10-20 doesn't match the 7 days terms (2026-09-27)",
      },
    ]);
    expect(codes(flags(clean({ paymentTermsDays: 30 })))).not.toContain('TERMS_MISMATCH');
    expect(codes(flags(clean({ paymentTermsDays: null })))).not.toContain('TERMS_MISMATCH');
    expect(codes(flags(clean({ paymentTermsDays: 7, dueDateSource: 'manual' })))).not.toContain(
      'TERMS_MISMATCH',
    );
  });

  it('DUE_DATE_DERIVED for terms and vendor_default, not printed or manual', () => {
    expect(
      only(flags(clean({ dueDate: '2026-10-20', dueDateSource: 'terms' })), 'DUE_DATE_DERIVED'),
    ).toEqual([
      {
        code: 'DUE_DATE_DERIVED',
        severity: 'info',
        field: 'dueDate',
        message: 'Due date computed from the payment terms (30 days)',
      },
    ]);
    expect(
      only(
        flags(
          clean({ dueDate: '2026-09-21', dueDateSource: 'vendor_default', paymentTermsDays: null }),
        ),
        'DUE_DATE_DERIVED',
      )[0]?.message,
    ).toBe("Due date computed from the vendor's default terms (1 day)");
    expect(codes(flags(clean({ dueDateSource: 'printed' })))).not.toContain('DUE_DATE_DERIVED');
    expect(codes(flags(clean({ dueDateSource: 'manual' })))).not.toContain('DUE_DATE_DERIVED');
  });

  it('FUTURE_DATE when the invoice date is after today', () => {
    const future = clean({ invoiceDate: '2026-10-03', serviceDate: null, dueDate: '2026-11-02' });
    expect(only(flags(future), 'FUTURE_DATE')).toEqual([
      {
        code: 'FUTURE_DATE',
        severity: 'warning',
        field: 'invoiceDate',
        message: 'Invoice date 2026-10-03 is in the future',
      },
    ]);
    expect(
      codes(flags(clean({ invoiceDate: TODAY, serviceDate: null, dueDate: '2026-11-01' }))),
    ).not.toContain('FUTURE_DATE');
  });

  it('SERVICE_AFTER_INVOICE when the service date is after the invoice date', () => {
    expect(only(flags(clean({ serviceDate: '2026-09-21' })), 'SERVICE_AFTER_INVOICE')).toEqual([
      {
        code: 'SERVICE_AFTER_INVOICE',
        severity: 'warning',
        field: 'serviceDate',
        message: 'Service date 2026-09-21 is after the invoice date 2026-09-20',
      },
    ]);
    expect(codes(flags(clean({ serviceDate: '2026-09-20' })))).not.toContain(
      'SERVICE_AFTER_INVOICE',
    );
  });

  it('PAY_IN_OTHER_CURRENCY when the amount due is in another currency', () => {
    expect(only(flags(clean({ amountDueCurrency: 'GEL' })), 'PAY_IN_OTHER_CURRENCY')).toEqual([
      {
        code: 'PAY_IN_OTHER_CURRENCY',
        severity: 'info',
        field: 'amountDueCurrency',
        message: 'Payable in GEL; the invoice is priced in USD',
      },
    ]);
    expect(codes(flags(clean({ amountDueCurrency: null })))).not.toContain('PAY_IN_OTHER_CURRENCY');
  });

  it('NOT_BILLED_TO_CAMEX unless the bill-to contains "camex" or "კამექს"; also when there is none', () => {
    expect(only(flags(clean({ billToName: 'Georgian Airways' })), 'NOT_BILLED_TO_CAMEX')).toEqual([
      {
        code: 'NOT_BILLED_TO_CAMEX',
        severity: 'warning',
        field: 'billToName',
        message: 'Billed to "Georgian Airways", not Camex',
      },
    ]);
    expect(only(flags(clean({ billToName: null })), 'NOT_BILLED_TO_CAMEX')[0]?.message).toBe(
      'No bill-to name found',
    );
    expect(codes(flags(clean({ billToName: 'CAMEX AIRLINES' })))).not.toContain(
      'NOT_BILLED_TO_CAMEX',
    );
    // "Camex" in Georgian passes too, in Mkhedruli and in Mtavruli (Georgian capitals).
    for (const billToName of ['შპს კამექს ეარლაინს', 'ᲙᲐᲛᲔᲥᲡ ᲔᲐᲠᲚᲐᲘᲜᲡ']) {
      expect(codes(flags(clean({ billToName })))).not.toContain('NOT_BILLED_TO_CAMEX');
    }
    expect(codes(flags(clean({ billToName: 'შპს ჯორჯიან ეარვეისი' })))).toContain(
      'NOT_BILLED_TO_CAMEX',
    );
    // Blank (e.g. after an edit) reads like none.
    expect(only(flags(clean({ billToName: '  ' })), 'NOT_BILLED_TO_CAMEX')[0]?.message).toBe(
      'No bill-to name found',
    );
  });

  it('NOT_AN_INVOICE for anything but an invoice or credit note', () => {
    for (const documentType of ['proforma', 'statement', 'other'] as const) {
      expect(only(flags(clean({ documentType })), 'NOT_AN_INVOICE')).toMatchObject([
        { severity: 'warning', field: 'documentType' },
      ]);
    }
    expect(codes(flags(clean({ documentType: 'credit_note' })))).not.toContain('NOT_AN_INVOICE');
    expect(codes(flags(clean({ documentType: null })))).not.toContain('NOT_AN_INVOICE');
  });

  describe('duplicates', () => {
    it('DUPLICATE_FILE: same sha256 on another non-rejected invoice, in any status', () => {
      for (const status of ['processing', 'needs_review', 'unpaid', 'paid'] as const) {
        const list = flags(clean(), {
          candidates: [candidate({ status, fileSha256: 'sha-self' })],
        });
        expect(only(list, 'DUPLICATE_FILE')).toEqual([
          {
            code: 'DUPLICATE_FILE',
            severity: 'error',
            field: null,
            message: 'The same PDF is also on another invoice',
          },
        ]);
      }
      expect(
        codes(
          flags(clean(), {
            candidates: [candidate({ status: 'rejected', fileSha256: 'sha-self' })],
          }),
        ),
      ).not.toContain('DUPLICATE_FILE');
      // The invoice itself is never its own duplicate.
      expect(
        codes(flags(clean(), { candidates: [candidate({ id: 'self', fileSha256: 'sha-self' })] })),
      ).toEqual([]);
    });

    it('DUPLICATE_NUMBER: same number key and the same vendor_id', () => {
      const list = flags(clean({ invoiceNumber: 'inv 1' }), {
        candidates: [candidate({ invoiceNumber: 'INV1' })],
      });
      expect(only(list, 'DUPLICATE_NUMBER')).toEqual([
        {
          code: 'DUPLICATE_NUMBER',
          severity: 'error',
          field: 'invoiceNumber',
          message: 'Invoice number inv 1 from this vendor is also on another invoice',
        },
      ]);
      // Different vendor, same number: not a duplicate (even with the same name).
      expect(
        codes(
          flags(clean(), {
            candidates: [candidate({ invoiceNumber: 'INV-1', vendorId: 'vendor-2' })],
          }),
        ),
      ).toEqual([]);
      expect(
        codes(
          flags(clean(), {
            candidates: [candidate({ invoiceNumber: 'INV-1', status: 'rejected' })],
          }),
        ),
      ).toEqual([]);
      expect(
        codes(flags(clean(), { candidates: [candidate({ invoiceNumber: 'INV-2' })] })),
      ).toEqual([]);
    });

    it('DUPLICATE_NUMBER: equal vendorKey(vendor_name) when either side is unlinked', () => {
      const unlinked = candidate({
        invoiceNumber: 'INV-1',
        vendorId: null,
        vendorName: 'ACME FUEL',
      });
      expect(codes(flags(clean(), { candidates: [unlinked] }))).toContain('DUPLICATE_NUMBER');
      const selfUnlinked = clean({ vendorId: null, vendorName: 'Acme Fuel, Ltd.' });
      expect(
        codes(
          flags(selfUnlinked, {
            vendor: null,
            candidates: [candidate({ invoiceNumber: 'INV-1', vendorId: 'vendor-9' })],
          }),
        ),
      ).toContain('DUPLICATE_NUMBER');
      expect(
        codes(
          flags(clean(), {
            candidates: [
              candidate({ invoiceNumber: 'INV-1', vendorId: null, vendorName: 'Other Fuel' }),
            ],
          }),
        ),
      ).not.toContain('DUPLICATE_NUMBER');
      // No number, no number duplicate.
      expect(
        codes(
          flags(clean({ invoiceNumber: null }), {
            candidates: [candidate({ invoiceNumber: null })],
          }),
        ),
      ).not.toContain('DUPLICATE_NUMBER');
    });
  });

  it('NEW_VENDOR without a vendor (and no bank flags then)', () => {
    expect(flags(clean({ vendorId: null }), { vendor: null })).toEqual([
      {
        code: 'NEW_VENDOR',
        severity: 'info',
        field: 'vendorName',
        message: 'No vendor matched: link an existing vendor or create one',
      },
    ]);
  });

  describe('bank details', () => {
    it('BANK_FIRST_SEEN: linked vendor without active trusted accounts', () => {
      expect(flags(clean(), { vendor: { trustedAccountKeys: [] } })).toEqual([
        {
          code: 'BANK_FIRST_SEEN',
          severity: 'warning',
          field: 'bankDetails.iban',
          message: 'First bank details seen for this vendor: verify them before trusting them',
        },
      ]);
    });

    it('BANK_UNKNOWN: the vendor has trusted accounts and none matches', () => {
      const list = flags(clean(), { vendor: { trustedAccountKeys: ['GE00OTHER'] } });
      expect(list).toEqual([
        {
          code: 'BANK_UNKNOWN',
          severity: 'error',
          field: 'bankDetails.iban',
          message:
            'Bank details differ from the ones on file: verify by phone with the vendor before paying',
        },
      ]);
    });

    it('matches by key (spaces and case ignored); account number when there is no IBAN', () => {
      const spaced = clean({
        bankDetails: { ...BANK, iban: 'ge00 tb00 0000 0000 0000 01' },
      });
      expect(flags(spaced)).toEqual([]);
      const account = clean({
        bankDetails: { ...BANK, iban: null, accountNumber: '4942 312687' },
      });
      expect(flags(account, { vendor: { trustedAccountKeys: ['4942312687'] } })).toEqual([]);
      expect(
        only(flags(account, { vendor: { trustedAccountKeys: [IBAN] } }), 'BANK_UNKNOWN')[0]?.field,
      ).toBe('bankDetails.accountNumber');
    });

    it('no bank flag without an IBAN or account number', () => {
      expect(flags(clean({ bankDetails: null }), { vendor: { trustedAccountKeys: [] } })).toEqual(
        [],
      );
      expect(
        flags(clean({ bankDetails: { ...BANK, iban: null } }), {
          vendor: { trustedAccountKeys: ['X'] },
        }),
      ).toEqual([]);
    });
  });

  describe('DISPUTE_SOON', () => {
    it('in 3 days (or less): "ends"', () => {
      expect(flags(clean({ disputeDeadline: '2026-10-05' }))).toEqual([
        {
          code: 'DISPUTE_SOON',
          severity: 'warning',
          field: 'disputeDeadline',
          message: 'Dispute window ends 2026-10-05',
        },
      ]);
      expect(only(flags(clean({ disputeDeadline: TODAY })), 'DISPUTE_SOON')[0]?.message).toBe(
        'Dispute window ends 2026-10-02',
      );
      expect(flags(clean({ disputeDeadline: '2026-10-06' }))).toEqual([]);
    });

    it('already passed: "ended"', () => {
      expect(
        only(flags(clean({ disputeDeadline: '2026-09-30' })), 'DISPUTE_SOON')[0]?.message,
      ).toBe('Dispute window ended 2026-09-30');
    });

    it('only in needs_review', () => {
      expect(flags(clean({ status: 'unpaid', disputeDeadline: '2026-10-03' }))).toEqual([]);
      expect(flags(clean({ status: 'paid', disputeDeadline: '2026-09-30' }))).toEqual([]);
    });
  });

  it('orders errors, then warnings, then info (SPEC table order within a severity)', () => {
    const invoice = clean({
      vendorId: null,
      totalAmount: '200.00', // TOTAL_MATH (error)
      lineItems: [
        {
          kind: 'item',
          description: 'x',
          quantity: '10',
          uom: null,
          unitPrice: '11',
          amount: '100.00',
        },
      ], // LINE_MATH (warning)
      invoiceDate: '2026-10-10', // FUTURE_DATE (warning)
      serviceDate: null,
      dueDate: '2026-10-09', // DUE_BEFORE_INVOICE (error)
      paymentTermsDays: null,
      amountDueCurrency: 'GEL', // PAY_IN_OTHER_CURRENCY (info)
      billToName: 'Someone else', // NOT_BILLED_TO_CAMEX (warning)
      disputeDeadline: '2026-10-01', // DISPUTE_SOON (warning)
    });
    const list = flags(invoice, {
      vendor: null,
      candidates: [candidate({ fileSha256: 'sha-self' })],
    });
    expect(list.map((f) => `${f.severity}:${f.code}`)).toEqual([
      'error:TOTAL_MATH',
      'error:DUE_BEFORE_INVOICE',
      'error:DUPLICATE_FILE',
      'warning:LINE_MATH',
      'warning:FUTURE_DATE',
      'warning:NOT_BILLED_TO_CAMEX',
      'warning:DISPUTE_SOON',
      'info:PAY_IN_OTHER_CURRENCY',
      'info:NEW_VENDOR',
    ]);
  });

  it('messages never contain bank account numbers', () => {
    const accountNumber = '4942312687';
    const invoice = clean({
      bankDetails: {
        ...BANK,
        accountNumber,
        swift: 'WFBIUS6S',
        routingNumber: '121000248',
      },
    });
    for (const vendor of [{ trustedAccountKeys: [] }, { trustedAccountKeys: ['X'] }, null]) {
      const text = JSON.stringify(flags(invoice, { vendor }));
      for (const secret of [IBAN, accountNumber, 'WFBIUS6S', '121000248']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

// ─── Fixture table (T04 "Tests"): golden files, today = 2026-10-02 ─────────────

type Fixture = 'asm' | 'petrocas' | 'aeg';

/** The golden file as the extraction write stores it (printed due date → source printed). */
function goldenInvoice(name: Fixture, overrides: Partial<FlagInvoice> = {}) {
  const g = expectedExtraction(name);
  const invoice: FlagInvoice = {
    id: name,
    status: 'needs_review',
    extractionStatus: 'succeeded',
    documentType: g.documentType,
    vendorId: null,
    vendorName: g.vendorName,
    billToName: g.billToName,
    invoiceNumber: g.invoiceNumber,
    invoiceDate: g.invoiceDate,
    serviceDate: g.serviceDate,
    dueDate: g.dueDate,
    dueDateSource: g.dueDate === null ? null : 'printed',
    paymentTermsDays: g.paymentTermsDays,
    disputeDeadline: null,
    currency: g.currency,
    totalAmount: g.totalAmount,
    taxAmount: g.taxAmount,
    amountDue: g.amountDue,
    amountDueCurrency: g.amountDueCurrency,
    lineItems: g.lineItems,
    bankDetails: g.bankDetails,
    fileSha256: name,
    ...overrides,
  };
  return { invoice, disputeWindowDays: g.disputeWindowDays };
}

/** deriveDates then computeFlags, like the evaluator. */
function evaluateFixture(
  name: Fixture,
  vendor: { defaultPaymentTermsDays: number | null; trustedAccountKeys: string[] } | null,
  overrides: Partial<FlagInvoice> = {},
) {
  const { invoice, disputeWindowDays } = goldenInvoice(name, {
    vendorId: vendor === null ? null : `vendor-${name}`,
    ...overrides,
  });
  const dates = deriveDates({ ...invoice, disputeWindowDays }, vendor);
  const list = computeFlags({ invoice: { ...invoice, ...dates }, vendor, candidates: [] }, TODAY);
  return {
    dates,
    flags: list.map((f) => ({
      code: f.code,
      severity: f.severity,
      field: f.field,
      message: f.message,
    })),
  };
}

const newVendor = {
  code: 'NEW_VENDOR',
  severity: 'info',
  field: 'vendorName',
  message: 'No vendor matched: link an existing vendor or create one',
};
const firstSeen = (field: string) => ({
  code: 'BANK_FIRST_SEEN',
  severity: 'warning',
  field,
  message: 'First bank details seen for this vendor: verify them before trusting them',
});
const disputeEnded = (date: string) => ({
  code: 'DISPUTE_SOON',
  severity: 'warning',
  field: 'disputeDeadline',
  message: `Dispute window ended ${date}`,
});
const payInGel = {
  code: 'PAY_IN_OTHER_CURRENCY',
  severity: 'info',
  field: 'amountDueCurrency',
  message: 'Payable in GEL; the invoice is priced in USD',
};
const noTrust = { defaultPaymentTermsDays: null, trustedAccountKeys: [] };

describe('fixtures (golden files, today 2026-10-02)', () => {
  it('asm, no vendors: DISPUTE_SOON (ended 2026-09-30) · NEW_VENDOR', () => {
    const { dates, flags: list } = evaluateFixture('asm', null);
    expect(dates).toEqual({
      dueDate: '2026-09-16',
      dueDateSource: 'printed',
      disputeDeadline: '2026-09-30',
    });
    expect(list).toEqual([disputeEnded('2026-09-30'), newVendor]);
  });

  it('asm, vendor without trusted accounts: BANK_FIRST_SEEN · DISPUTE_SOON', () => {
    expect(evaluateFixture('asm', noTrust).flags).toEqual([
      firstSeen('bankDetails.iban'),
      disputeEnded('2026-09-30'),
    ]);
  });

  it('petrocas, no vendors: MISSING_REQUIRED dueDate · PAY_IN_OTHER_CURRENCY · NEW_VENDOR', () => {
    const { dates, flags: list } = evaluateFixture('petrocas', null);
    expect(dates).toEqual({ dueDate: null, dueDateSource: null, disputeDeadline: null });
    expect(list).toEqual([
      {
        code: 'MISSING_REQUIRED',
        severity: 'error',
        field: 'dueDate',
        message: 'Due date is missing',
      },
      payInGel,
      newVendor,
    ]);
  });

  it('petrocas, vendor with default terms 10: due 2026-10-12 (vendor_default); BANK_FIRST_SEEN · DUE_DATE_DERIVED · PAY_IN_OTHER_CURRENCY', () => {
    const { dates, flags: list } = evaluateFixture('petrocas', {
      defaultPaymentTermsDays: 10,
      trustedAccountKeys: [],
    });
    expect(dates).toEqual({
      dueDate: '2026-10-12',
      dueDateSource: 'vendor_default',
      disputeDeadline: null,
    });
    expect(list).toEqual([
      firstSeen('bankDetails.iban'),
      {
        code: 'DUE_DATE_DERIVED',
        severity: 'info',
        field: 'dueDate',
        message: "Due date computed from the vendor's default terms (10 days)",
      },
      payInGel,
    ]);
  });

  it('aeg, no vendors: DISPUTE_SOON (ended 2026-09-24) · NEW_VENDOR', () => {
    const { dates, flags: list } = evaluateFixture('aeg', null);
    expect(dates).toEqual({
      dueDate: '2026-09-21',
      dueDateSource: 'printed',
      disputeDeadline: '2026-09-24',
    });
    expect(list).toEqual([disputeEnded('2026-09-24'), newVendor]);
  });

  it('aeg, vendor without trusted accounts: BANK_FIRST_SEEN · DISPUTE_SOON', () => {
    expect(evaluateFixture('aeg', noTrust).flags).toEqual([
      firstSeen('bankDetails.accountNumber'),
      disputeEnded('2026-09-24'),
    ]);
  });

  it("after trusting AEG's account, a second AEG invoice with another account number gets BANK_UNKNOWN; the first has no bank flag", () => {
    const aegBank = expectedExtraction('aeg').bankDetails;
    const trusted = {
      defaultPaymentTermsDays: null,
      trustedAccountKeys: [bankAccountKey(aegBank) ?? ''],
    };
    expect(evaluateFixture('aeg', trusted).flags).toEqual([disputeEnded('2026-09-24')]);

    const second = evaluateFixture('aeg', trusted, {
      id: 'aeg-2',
      invoiceNumber: '3110999',
      bankDetails: aegBank && { ...aegBank, accountNumber: '9999999999' },
    });
    expect(second.flags).toEqual([
      {
        code: 'BANK_UNKNOWN',
        severity: 'error',
        field: 'bankDetails.accountNumber',
        message:
          'Bank details differ from the ones on file: verify by phone with the vendor before paying',
      },
      disputeEnded('2026-09-24'),
    ]);
  });
});
