import { emptyExtractionOutputV1 } from '@camex/shared';
import { describe, expect, it } from 'vitest';
import {
  aircraftRegistration,
  bankDetails,
  calendarDate,
  currencyCode,
  dayCount,
  decimal,
  flightNumbers,
  iataCode,
  icaoCode,
  name,
  normalizeExtraction,
  taxId,
  text,
} from '../src/extraction/normalize.js';
import { asmWireOutput, expectedExtraction, wireFromExpected } from './helpers.js';

const emptyBank = emptyExtractionOutputV1().bankDetails;

describe('normalization (wire → domain)', () => {
  it('strings: trimmed, "" → null; names also collapse whitespace', () => {
    expect(text('  NET7 ')).toBe('NET7');
    expect(text('')).toBeNull();
    expect(text('   ')).toBeNull();
    expect(text('a  b')).toBe('a  b');
    expect(name('  Petrocas   Fuel\n Services ')).toBe('Petrocas Fuel Services');
    expect(name('')).toBeNull();
  });

  it('dates: real calendar dates only', () => {
    expect(calendarDate('2026-09-16')).toBe('2026-09-16');
    expect(calendarDate(' 2028-02-29 ')).toBe('2028-02-29');
    expect(calendarDate('2026-02-30')).toBeNull();
    expect(calendarDate('2026-02-29')).toBeNull();
    expect(calendarDate('2026-13-01')).toBeNull();
    expect(calendarDate('16-Sep-2026')).toBeNull();
    expect(calendarDate('')).toBeNull();
  });

  it('decimals: spaces and thousands commas stripped, otherwise kept as returned', () => {
    expect(decimal('15,617.79')).toBe('15617.79');
    expect(decimal('1,334.590')).toBe('1334.590');
    expect(decimal('1,000,000')).toBe('1000000');
    expect(decimal(' 88 753.98 ')).toBe('88753.98');
    expect(decimal('-12.50')).toBe('-12.50');
    expect(decimal('4.629053')).toBe('4.629053');
    expect(decimal('0')).toBe('0');
    expect(decimal('')).toBeNull();
    // A decimal comma is not a thousands separator: null rather than a different number.
    expect(decimal('15.617,79')).toBeNull();
    expect(decimal('12,5')).toBeNull();
    expect(decimal('$12.50')).toBeNull();
    expect(decimal('1e5')).toBeNull();
  });

  it('decimals: more than 14 integer digits (too big for numeric(18,4)) → null', () => {
    expect(decimal('99999999999999.9999')).toBe('99999999999999.9999');
    expect(decimal('-99999999999999')).toBe('-99999999999999');
    expect(decimal('99,999,999,999,999.99')).toBe('99999999999999.99');
    expect(decimal('100000000000000')).toBeNull();
    expect(decimal('-123456789012345.5')).toBeNull();
    expect(decimal('100,000,000,000,000')).toBeNull();
    // Leading zeros don't count: the value still fits.
    expect(decimal('000000000000000001.5')).toBe('000000000000000001.5');
    expect(decimal('0.123456789012345678')).toBe('0.123456789012345678');
  });

  it('day counts: integers or null', () => {
    expect(dayCount('30')).toBe(30);
    expect(dayCount('0')).toBe(0);
    expect(dayCount('')).toBeNull();
    expect(dayCount('7 days')).toBeNull();
    expect(dayCount('1.5')).toBeNull();
  });

  it('currency, ICAO and IATA codes: uppercase and the right shape, else null', () => {
    expect(currencyCode('usd')).toBe('USD');
    expect(currencyCode('US$')).toBeNull();
    expect(currencyCode('')).toBeNull();
    expect(icaoCode('lhbp')).toBe('LHBP');
    expect(icaoCode('BUD')).toBeNull();
    expect(iataCode('otp')).toBe('OTP');
    expect(iataCode('LROP')).toBeNull();
  });

  it('vendorTaxId: uppercase, no spaces', () => {
    expect(taxId(' ro 482 454 63 ')).toBe('RO48245463');
    expect(taxId('')).toBeNull();
  });

  it('aircraftRegistration: uppercase, no spaces, 4L gets its hyphen', () => {
    expect(aircraftRegistration('4LCMX')).toBe('4L-CMX');
    expect(aircraftRegistration('4l cmx')).toBe('4L-CMX');
    expect(aircraftRegistration('4L-CME')).toBe('4L-CME');
    expect(aircraftRegistration('ER-AXV')).toBe('ER-AXV');
    expect(aircraftRegistration('n123ab')).toBe('N123AB');
    expect(aircraftRegistration('')).toBeNull();
  });

  it('flightNumbers: shorthand expanded, uppercase, no spaces, deduped, in order', () => {
    expect(flightNumbers(['CMS503/4'])).toEqual(['CMS503', 'CMS504']);
    expect(flightNumbers(['CMS503/504'])).toEqual(['CMS503', 'CMS504']);
    expect(flightNumbers(['CMS1009/10'])).toEqual(['CMS1009', 'CMS1010']);
    expect(flightNumbers(['CMS503/CMS504'])).toEqual(['CMS503', 'CMS504']);
    expect(flightNumbers(['cms 624'])).toEqual(['CMS624']);
    expect(flightNumbers(['CMS503/4', 'CMS504', 'CMS101', ''])).toEqual([
      'CMS503',
      'CMS504',
      'CMS101',
    ]);
    expect(flightNumbers([])).toEqual([]);
  });

  it('bank details: IBAN/SWIFT lose spaces and dashes, accounts lose spaces', () => {
    expect(
      bankDetails({
        ...emptyBank,
        beneficiary: ' Associated  Energy Group LLC ',
        iban: 'ge71 tb76-9203 6030 1000 01',
        swift: 'tbcb-ge22',
        accountNumber: '4942 312687',
        routingNumber: '1210 00248',
        currency: 'gel',
      }),
    ).toEqual({
      beneficiary: 'Associated Energy Group LLC',
      bankName: null,
      iban: 'GE71TB7692036030100001',
      accountNumber: '4942312687',
      swift: 'TBCBGE22',
      routingNumber: '121000248',
      currency: 'GEL',
    });
  });

  it('bank details: an account number equal to the IBAN is dropped', () => {
    expect(
      bankDetails({
        ...emptyBank,
        iban: 'AE30 0440 0001 0123 6468 501',
        accountNumber: 'AE300440000101236468501',
      }),
    ).toMatchObject({ iban: 'AE300440000101236468501', accountNumber: null });
  });

  it('bank details: null when every field is empty', () => {
    expect(bankDetails(emptyBank)).toBeNull();
    expect(bankDetails({ ...emptyBank, iban: '  ', currency: 'U$' })).toBeNull();
  });

  it('turns an all-empty output into nulls', () => {
    expect(normalizeExtraction(emptyExtractionOutputV1())).toEqual({
      ...Object.fromEntries(
        Object.keys(emptyExtractionOutputV1()).map((key) => [key, null] as const),
      ),
      documentType: 'other',
      category: 'other',
      flightNumbers: [],
      lineItems: [],
    });
  });

  it('round-trips every golden file and normalizes what a model prints', () => {
    for (const fixture of ['asm', 'petrocas', 'aeg'] as const) {
      const expected = expectedExtraction(fixture);
      expect(normalizeExtraction(wireFromExpected(expected))).toEqual(expected);
    }
    expect(normalizeExtraction(asmWireOutput())).toEqual(expectedExtraction('asm'));
  });
});
