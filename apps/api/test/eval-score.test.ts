import { describe, expect, it } from 'vitest';
import {
  decimalEquals,
  namesMatch,
  normalizeName,
  scoreExtraction,
} from '../src/extraction/eval/score.js';
import { expectedExtraction } from './helpers.js';

const aeg = expectedExtraction('aeg');
const asm = expectedExtraction('asm');

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture value missing');
  return value;
}
const asmBank = defined(asm.bankDetails);

describe('eval scorer', () => {
  it('decimals compare numerically, without floats', () => {
    expect(decimalEquals('1334.590', '1334.59')).toBe(true);
    expect(decimalEquals('10.000000', '10')).toBe(true);
    expect(decimalEquals('0.00', '0')).toBe(true);
    expect(decimalEquals('-0.0', '0')).toBe(true);
    expect(decimalEquals('007.5', '7.50')).toBe(true);
    expect(decimalEquals('15617.79', '15617.790001')).toBe(false);
    expect(decimalEquals('-5', '5')).toBe(false);
    expect(decimalEquals(null, null)).toBe(true);
    expect(decimalEquals(null, '0')).toBe(false);
  });

  it('names: case, punctuation and legal suffixes ignored; containment passes', () => {
    expect(normalizeName('Wells Fargo Bank, N.A.')).toBe('wells fargo bank');
    expect(normalizeName('AEG Fuels Ireland Limited')).toBe('aeg fuels ireland');
    expect(namesMatch('Aviation Services Management FZE', 'AVIATION SERVICES MANAGEMENT')).toBe(
      true,
    );
    expect(namesMatch('Camex Airlines LLC', 'Camex Airlines')).toBe(true);
    expect(namesMatch('Camex Airlines LLC', 'Camex')).toBe(true);
    expect(namesMatch('Standard Chartered Bank', 'Standard Chartered Bank, Dubai')).toBe(true);
    expect(namesMatch('TBC Bank', 'Bank of Georgia')).toBe(false);
    // Whole words only, and a bare suffix doesn't match everything.
    expect(namesMatch('Camex Airlines LLC', 'Air')).toBe(false);
    expect(namesMatch('Camex Airlines LLC', 'LLC')).toBe(false);
    expect(namesMatch(null, null)).toBe(true);
    expect(namesMatch('TBC Bank', null)).toBe(false);
  });

  it('a perfect extraction has no mismatches', () => {
    expect(scoreExtraction(aeg, aeg).mismatches).toEqual([]);
  });

  it('reports each scored field with its rule; unscored fields never fail', () => {
    const score = scoreExtraction(aeg, {
      ...aeg,
      invoiceDate: '2026-09-14',
      dueDate: '2026-09-12',
      flightNumbers: ['CMS625'],
      totalAmount: '6461.290',
      taxAmount: null,
      vendorName: 'AEG Fuels',
      billToName: 'Somebody Else Ltd',
      description: 'anything',
      notes: null,
    });
    expect(score.mismatches).toEqual([
      { rule: 'exact', field: 'dueDate', expected: '2026-09-21', actual: '2026-09-12' },
      { rule: 'set', field: 'flightNumbers', expected: ['CMS624'], actual: ['CMS625'] },
      { rule: 'decimal', field: 'taxAmount', expected: '0', actual: null },
      {
        rule: 'name',
        field: 'billToName',
        expected: 'Camex Airlines LLC',
        actual: 'Somebody Else Ltd',
      },
    ]);
    expect(score.unscored.find((d) => d.field === 'description')).toEqual({
      field: 'description',
      expected: aeg.description,
      actual: 'anything',
    });
  });

  it('flight numbers compare as a set', () => {
    const swapped = { ...asm, flightNumbers: ['CMS504', 'CMS503'] };
    expect(scoreExtraction(asm, swapped).mismatches).toEqual([]);
  });

  it('bank details: a missing block compares like an empty one', () => {
    const score = scoreExtraction(aeg, { ...aeg, bankDetails: null });
    expect(score.mismatches.map((m) => m.field)).toEqual([
      'bankDetails.accountNumber',
      'bankDetails.swift',
      'bankDetails.routingNumber',
      'bankDetails.currency',
      'bankDetails.bankName',
      'bankDetails.beneficiary',
    ]);
  });

  it('beneficiary: no beneficiary expected passes when the vendor is named instead', () => {
    const withVendor = {
      ...asm,
      bankDetails: { ...asmBank, beneficiary: 'Aviation Services Management FZE' },
    };
    expect(scoreExtraction(asm, withVendor).mismatches).toEqual([]);
    const withOther = {
      ...asm,
      bankDetails: { ...asmBank, beneficiary: 'Someone Else LLC' },
    };
    expect(scoreExtraction(asm, withOther).mismatches.map((m) => m.field)).toEqual([
      'bankDetails.beneficiary',
    ]);
  });

  it('line items: the count must match, then lines compare in order', () => {
    const fewer = scoreExtraction(aeg, { ...aeg, lineItems: aeg.lineItems.slice(0, 4) });
    expect(fewer.mismatches).toEqual([
      { rule: 'count', field: 'lineItems.length', expected: 5, actual: 4 },
    ]);

    const [first, second, ...rest] = aeg.lineItems;
    const swapped = scoreExtraction(aeg, {
      ...aeg,
      lineItems: [
        defined(first),
        { ...defined(second), quantity: '10.000', unitPrice: '1.000000' },
        ...rest,
      ],
    });
    expect(swapped.mismatches).toEqual([
      { rule: 'decimal', field: 'lineItems[1].quantity', expected: '1.000', actual: '10.000' },
      {
        rule: 'decimal',
        field: 'lineItems[1].unitPrice',
        expected: '10.000000',
        actual: '1.000000',
      },
    ]);
    // kind, uom and description are shown, not scored
    const relabelled = scoreExtraction(aeg, {
      ...aeg,
      lineItems: aeg.lineItems.map((line) => ({ ...line, kind: 'item' as const, uom: 'X' })),
    });
    expect(relabelled.mismatches).toEqual([]);
  });
});
