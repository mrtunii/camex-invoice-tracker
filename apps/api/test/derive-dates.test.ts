import { describe, expect, it } from 'vitest';
import { type DateFields, deriveDates } from '../src/evaluation/derive-dates.js';

const base: DateFields = {
  invoiceDate: '2026-09-14',
  dueDate: null,
  dueDateSource: null,
  paymentTermsDays: null,
  disputeWindowDays: null,
};
const vendorTerms = (days: number | null) => ({ defaultPaymentTermsDays: days });

describe('deriveDates', () => {
  it('keeps a printed due date, even when the terms disagree', () => {
    expect(
      deriveDates(
        { ...base, dueDate: '2026-09-25', dueDateSource: 'printed', paymentTermsDays: 7 },
        vendorTerms(30),
      ),
    ).toEqual({ dueDate: '2026-09-25', dueDateSource: 'printed', disputeDeadline: null });
  });

  it('keeps a manual due date', () => {
    expect(
      deriveDates(
        { ...base, dueDate: '2026-10-31', dueDateSource: 'manual', paymentTermsDays: 7 },
        vendorTerms(30),
      ),
    ).toEqual({ dueDate: '2026-10-31', dueDateSource: 'manual', disputeDeadline: null });
  });

  it('without one: invoice date + payment terms (source terms), before the vendor default', () => {
    expect(deriveDates({ ...base, paymentTermsDays: 7 }, vendorTerms(30))).toEqual({
      dueDate: '2026-09-21',
      dueDateSource: 'terms',
      disputeDeadline: null,
    });
    expect(deriveDates({ ...base, paymentTermsDays: 0 }, null)).toMatchObject({
      dueDate: '2026-09-14',
      dueDateSource: 'terms',
    });
  });

  it('re-derives a previously derived date (terms, vendor_default) from the current inputs', () => {
    expect(
      deriveDates(
        { ...base, dueDate: '2026-09-21', dueDateSource: 'terms', paymentTermsDays: 10 },
        null,
      ),
    ).toMatchObject({ dueDate: '2026-09-24', dueDateSource: 'terms' });
    expect(
      deriveDates({ ...base, dueDate: '2026-09-24', dueDateSource: 'vendor_default' }, null),
    ).toMatchObject({ dueDate: null, dueDateSource: null });
  });

  it('else invoice date + the vendor default terms (source vendor_default)', () => {
    expect(deriveDates(base, vendorTerms(10))).toEqual({
      dueDate: '2026-09-24',
      dueDateSource: 'vendor_default',
      disputeDeadline: null,
    });
    expect(deriveDates(base, vendorTerms(0))).toMatchObject({
      dueDate: '2026-09-14',
      dueDateSource: 'vendor_default',
    });
  });

  it('else no due date and no source', () => {
    expect(deriveDates(base, vendorTerms(null))).toEqual({
      dueDate: null,
      dueDateSource: null,
      disputeDeadline: null,
    });
    expect(deriveDates(base, null)).toMatchObject({ dueDate: null, dueDateSource: null });
    // Terms but no invoice date: nothing to count from.
    expect(
      deriveDates({ ...base, invoiceDate: null, paymentTermsDays: 7 }, vendorTerms(10)),
    ).toMatchObject({ dueDate: null, dueDateSource: null });
  });

  it('dispute deadline = invoice date + dispute window, always derived, else null', () => {
    expect(deriveDates({ ...base, disputeWindowDays: 10 }, null).disputeDeadline).toBe(
      '2026-09-24',
    );
    expect(
      deriveDates(
        { ...base, disputeWindowDays: 14, dueDate: '2026-09-14', dueDateSource: 'manual' },
        null,
      ).disputeDeadline,
    ).toBe('2026-09-28');
    expect(
      deriveDates({ ...base, invoiceDate: null, disputeWindowDays: 14 }, null).disputeDeadline,
    ).toBeNull();
  });
});
