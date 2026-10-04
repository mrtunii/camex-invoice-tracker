import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvoiceEvent } from '@camex/shared';
import { activityEntry, formatFieldValue } from './activity.ts';

const TODAY = '2026-10-04';
const NINO = { id: '11111111-1111-4111-8111-111111111111', name: 'Nino' };
const OTTO = { id: '22222222-2222-4222-8222-222222222222', name: 'Otto' };
const AEG = { id: '33333333-3333-4333-8333-333333333333', name: 'AEG Fuels' };

let counter = 0;
function event(
  type: InvoiceEvent['type'],
  data: Record<string, unknown>,
  extra: Partial<InvoiceEvent> = {},
): InvoiceEvent {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    type,
    // 10:02 UTC is 14:02 in Tbilisi.
    at: '2026-10-03T10:02:00.000Z',
    user: null,
    vendor: null,
    data,
    ...extra,
  };
}

const text = (e: InvoiceEvent) => activityEntry(e, TODAY).text;

void describe('activity sentences', () => {
  void it('approvals, with the time in Tbilisi and the year only for other years', () => {
    const entry = activityEntry(event('approved', { overriddenFlags: [] }, { user: NINO }), TODAY);
    assert.equal(entry.text, 'Nino approved');
    assert.equal(entry.when, '3 Oct, 14:02');
    assert.equal(
      activityEntry(
        event('approved', { overriddenFlags: [] }, { user: NINO, at: '2025-12-31T21:30:00Z' }),
        TODAY,
      ).when,
      // Already 1 Jan 2026 in Tbilisi: this year.
      '1 Jan, 01:30',
    );
    assert.equal(
      activityEntry(
        event('approved', { overriddenFlags: [] }, { user: NINO, at: '2025-06-01T08:00:00Z' }),
        TODAY,
      ).when,
      '1 Jun 2025, 12:00',
    );
  });

  void it('an approval that overrode error flags says so in words, never codes', () => {
    const entry = text(
      event(
        'approved',
        { overriddenFlags: ['BANK_UNKNOWN', 'DUPLICATE_NUMBER', 'SOMETHING_NEW'] },
        { user: NINO },
      ),
    );
    assert.equal(
      entry,
      'Nino approved despite bank details that differ from the ones on file, a duplicate invoice number and an error flag',
    );
    assert.doesNotMatch(entry, /[A-Z]{2,}_/);
  });

  void it('one changed field reads as from → to, with formatted values', () => {
    assert.equal(
      text(event('edited', { amountDue: { from: '6461.29', to: '6416.29' } }, { user: OTTO })),
      'Otto changed Amount due from 6,461.29 to 6,416.29',
    );
    assert.equal(
      text(event('edited', { dueDate: { from: null, to: '2026-10-09' } }, { user: OTTO })),
      'Otto set Due date to 9 Oct 2026',
    );
    assert.equal(
      text(event('edited', { notes: { from: 'Late fee 1 %', to: null } }, { user: OTTO })),
      'Otto cleared Notes (was Late fee 1 %)',
    );
    assert.equal(
      text(event('edited', { category: { from: 'other', to: 'fuel' } }, { user: OTTO })),
      'Otto changed Category from Other to Fuel',
    );
    assert.equal(
      text(event('edited', { paymentTermsDays: { from: 7, to: 30 } }, { user: OTTO })),
      'Otto changed Terms in days from 7 days to 30 days',
    );
  });

  void it('several fields: listed in the sentence, one line each', () => {
    const entry = activityEntry(
      event(
        'edited',
        {
          amountDue: { from: '6461.29', to: '6416.29' },
          flightNumbers: { from: ['CMS624'], to: ['CMS624', 'CMS625'] },
          invoiceDate: { from: '2026-09-14', to: '2026-09-15' },
        },
        { user: OTTO },
      ),
      TODAY,
    );
    assert.equal(entry.text, 'Otto changed Amount due, Flights and Invoice date');
    assert.deepEqual(
      entry.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`),
      [
        'Amount due: 6,461.29 → 6,416.29',
        'Flights: CMS624 → CMS624, CMS625',
        'Invoice date: 14 Sep 2026 → 15 Sep 2026',
      ],
    );
    assert.deepEqual(entry.details, []);
  });

  void it('bank details are summarised by field name; the values sit behind Show', () => {
    const before = {
      beneficiary: 'AEG Fuels',
      bankName: 'Barclays',
      iban: 'GB29NWBK60161331926819',
      accountNumber: null,
      swift: 'BARCGB22',
      routingNumber: null,
      currency: 'USD',
    };
    const entry = activityEntry(
      event(
        'edited',
        {
          bankDetails: {
            from: before,
            to: { ...before, iban: 'GB33BUKB20201555555555', swift: 'BUKBGB22' },
          },
        },
        { user: OTTO },
      ),
      TODAY,
    );
    assert.equal(entry.text, 'Otto changed bank details: IBAN and SWIFT');
    assert.deepEqual(entry.details, [
      { label: 'IBAN', from: 'GB29NWBK60161331926819', to: 'GB33BUKB20201555555555', mono: true },
      { label: 'SWIFT', from: 'BARCGB22', to: 'BUKBGB22', mono: true },
    ]);
    // The sentence itself never carries account numbers.
    assert.doesNotMatch(entry.text, /GB29|GB33/);

    const added = activityEntry(
      event('edited', { bankDetails: { from: null, to: before } }, { user: OTTO }),
      TODAY,
    );
    assert.equal(
      added.text,
      'Otto changed bank details: Beneficiary, Bank, IBAN, SWIFT and Account currency',
    );
  });

  void it('line items: the count change in the sentence, the differing lines behind Show', () => {
    const fuel = {
      kind: 'item',
      description: 'Jet A-1',
      quantity: '1334.590',
      uom: 'USG',
      unitPrice: '4.84',
      amount: '6459.42',
    };
    const fee = {
      kind: 'fee',
      description: 'Into-plane fee',
      quantity: null,
      uom: null,
      unitPrice: null,
      amount: '0.40',
    };
    const entry = activityEntry(
      event(
        'edited',
        {
          lineItems: { from: [fuel], to: [{ ...fuel, amount: '6459.43' }, fee] },
          amountDue: { from: '6459.42', to: '6459.83' },
        },
        { user: OTTO },
      ),
      TODAY,
    );
    assert.equal(entry.text, 'Otto changed Amount due and line items (1 line → 2)');
    assert.deepEqual(entry.changes, [
      { label: 'Amount due', from: '6,459.42', to: '6,459.83', mono: false },
    ]);
    assert.deepEqual(entry.details, [
      {
        label: 'Line 1',
        from: 'Jet A-1 · 1334.590 USG × 4.84 = 6,459.42',
        to: 'Jet A-1 · 1334.590 USG × 4.84 = 6,459.43',
      },
      { label: 'Line 2', from: '—', to: 'Fee: Into-plane fee · 0.40' },
    ]);
  });

  void it('vendor matches by the system, manual links and trusted bank details', () => {
    assert.equal(
      text(event('vendor_linked', { vendorId: AEG.id, method: 'name' }, { vendor: AEG })),
      'Matched to AEG Fuels by name',
    );
    assert.equal(
      text(event('vendor_linked', { vendorId: AEG.id, method: 'email_domain' }, { vendor: AEG })),
      "Matched to AEG Fuels by the sender's email domain",
    );
    assert.equal(
      text(
        event('vendor_linked', { vendorId: AEG.id, method: 'manual' }, { vendor: AEG, user: OTTO }),
      ),
      'Otto linked it to AEG Fuels',
    );
    assert.equal(
      text(
        event(
          'bank_account_trusted',
          { vendorId: AEG.id, accountId: NINO.id },
          { vendor: AEG, user: NINO },
        ),
      ),
      'Nino trusted the bank details for AEG Fuels',
    );
  });

  void it('payment, undo, rejection and reopening', () => {
    assert.equal(
      text(
        event(
          'paid',
          { paidAt: '2026-10-04', reference: 'TRX-2291', overriddenFlags: [] },
          { user: NINO },
        ),
      ),
      'Nino marked it paid on 4 Oct 2026 · ref TRX-2291',
    );
    assert.equal(
      text(event('paid', { paidAt: '2026-10-04', reference: null }, { user: NINO })),
      'Nino marked it paid on 4 Oct 2026',
    );
    assert.equal(
      text(event('payment_undone', { previousPaidAt: '2026-10-04' }, { user: OTTO })),
      'Otto undid the payment of 4 Oct 2026',
    );
    const rejected = activityEntry(
      event('rejected', { reason: 'duplicate', note: 'Same as SI-000218719' }, { user: NINO }),
      TODAY,
    );
    assert.equal(rejected.text, 'Nino rejected it: duplicate');
    assert.equal(rejected.note, 'Same as SI-000218719');
    assert.equal(
      text(event('rejected', { reason: 'other', note: 'Wrong entity' }, { user: NINO })),
      'Nino rejected it',
    );
    assert.equal(
      text(event('reopened', { from: 'rejected' }, { user: OTTO })),
      'Otto reopened it for review (it was rejected)',
    );
    assert.equal(
      text(event('reextracted', {}, { user: OTTO })),
      'Otto asked for a fresh reading of the PDF',
    );
  });

  void it('system events: received, read, failed', () => {
    assert.equal(text(event('received', { source: 'mailgun' })), 'Received by email');
    assert.equal(
      text(event('received', { source: 'manual' }, { user: OTTO })),
      'Otto uploaded the PDF',
    );
    assert.equal(text(event('extracted', { model: 'x' })), 'Read the PDF');
    const failed = activityEntry(event('extraction_failed', { error: 'Timed out' }), TODAY);
    assert.equal(failed.text, "Couldn't read the PDF");
    assert.equal(failed.note, 'Timed out');
  });

  void it('unexpected data still gives a sentence', () => {
    assert.equal(text(event('edited', { nonsense: 1 }, { user: OTTO })), 'Otto edited the invoice');
    assert.equal(text(event('approved', {}, { user: OTTO })), 'Otto approved');
    assert.equal(formatFieldValue('amountDue', null), '—');
    assert.equal(formatFieldValue('documentType', 'credit_note'), 'Credit note');
  });
});
