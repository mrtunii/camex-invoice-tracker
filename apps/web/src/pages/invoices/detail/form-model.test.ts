import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExtractedInvoice } from '@camex/shared';
import { diffForm, differsFromExtraction, emptyLine, toFormValues } from './form-model.ts';

const saved: ExtractedInvoice = {
  documentType: 'invoice',
  vendorName: 'AEG Fuels Ireland Ltd',
  vendorTaxId: null,
  billToName: 'Camex Airlines LLC',
  invoiceNumber: '3110713',
  invoiceDate: '2026-09-14',
  serviceDate: null,
  dueDate: '2026-09-21',
  paymentTermsText: 'NET7',
  paymentTermsDays: 7,
  disputeWindowDays: 10,
  category: 'fuel',
  description: null,
  airportIcao: 'LROP',
  airportIata: 'OTP',
  locationText: null,
  aircraftRegistration: '4L-CMX',
  flightNumbers: ['CMS624'],
  currency: 'USD',
  subtotalAmount: null,
  taxAmount: null,
  totalAmount: '6461.29',
  amountDue: '6461.29',
  amountDueCurrency: 'USD',
  lineItems: [
    {
      kind: 'item',
      description: 'Jet A-1',
      quantity: '1334.590',
      uom: 'USG',
      unitPrice: '4.84',
      amount: '6459.42',
    },
  ],
  bankDetails: {
    beneficiary: 'Associated Energy Group LLC',
    bankName: null,
    iban: 'GB29NWBK60161331926819',
    accountNumber: null,
    swift: 'NWBKGB2L',
    routingNumber: null,
    currency: 'USD',
  },
  notes: null,
};

void describe('review form model', () => {
  void it('an untouched form has no changes', () => {
    assert.deepEqual(diffForm(toFormValues(saved), saved), { dirty: [], changes: {}, issues: [] });
  });

  void it('only changed fields are sent, normalized as the API would', () => {
    const values = {
      ...toFormValues(saved),
      amountDue: '6,416.29',
      aircraftRegistration: '4lcmx', // the same registration, typed differently
      flightNumbers: 'cms624 cms625',
      airportIata: 'otp',
    };
    const diff = diffForm(values, saved);
    assert.deepEqual(diff.dirty, ['flightNumbers', 'amountDue']);
    assert.deepEqual(diff.changes, { flightNumbers: ['CMS624', 'CMS625'], amountDue: '6416.29' });
    assert.deepEqual(diff.issues, []);
  });

  void it('clearing a field sends null; empty line rows are dropped', () => {
    const values = {
      ...toFormValues(saved),
      dueDate: '',
      lineItems: [...toFormValues(saved).lineItems, emptyLine()],
    };
    const diff = diffForm(values, saved);
    assert.deepEqual(diff.changes, { dueDate: null });
  });

  void it('values the API would refuse are reported at their form path', () => {
    const values = toFormValues(saved);
    values.totalAmount = '12,5';
    values.paymentTermsDays = 'seven';
    values.bankDetails.currency = 'dollars';
    const first = values.lineItems[0];
    assert.ok(first);
    first.unitPrice = '4.8412345';
    const diff = diffForm(values, saved);
    assert.deepEqual(
      diff.issues.map((issue) => issue.path),
      ['paymentTermsDays', 'totalAmount', 'lineItems.0.unitPrice', 'bankDetails.currency'],
    );
    assert.deepEqual(diff.changes, {});
    assert.equal(diff.dirty.length, 4);
  });

  void it('amounts read as money and compare by value ("2298.5" is "2298.50")', () => {
    const stored = { ...saved, amountDue: '2298.5', totalAmount: '780', taxAmount: '0' };
    const values = toFormValues(stored);
    assert.equal(values.amountDue, '2298.50');
    assert.equal(values.totalAmount, '780.00');
    assert.equal(values.taxAmount, '0.00');
    assert.deepEqual(diffForm(values, stored).dirty, []);
    const extracted = { ...saved, amountDue: '2298.50' };
    const manual = { dueDate: saved.dueDate, dueDateSource: 'printed' as const };
    assert.equal(differsFromExtraction('amountDue', values, extracted, manual), false);
    values.amountDue = '2,298.51';
    assert.equal(differsFromExtraction('amountDue', values, extracted, manual), true);
  });

  void it('a derived due date is not an edit; a person-set one is', () => {
    const extracted = { ...saved, dueDate: null };
    const derived = { dueDate: '2026-09-21', dueDateSource: 'terms' as const };
    const values = toFormValues(saved);
    assert.equal(differsFromExtraction('dueDate', values, extracted, derived), false);
    values.dueDate = '2026-09-30';
    assert.equal(differsFromExtraction('dueDate', values, extracted, derived), true);
    const manual = { dueDate: '2026-09-30', dueDateSource: 'manual' as const };
    assert.equal(differsFromExtraction('dueDate', values, extracted, manual), true);
    assert.equal(differsFromExtraction('amountDue', values, extracted, manual), false);
  });
});
