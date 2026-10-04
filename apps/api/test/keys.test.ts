import {
  addDays,
  bankAccountKey,
  businessToday,
  daysBetween,
  invoiceNumberKey,
  vendorKey,
} from '@camex/shared';
import { describe, expect, it } from 'vitest';

// Shared helpers (packages/shared), tested here because the shared package has no test runner.

const at = (iso: string) => ({ now: () => new Date(iso) });

describe('vendorKey', () => {
  it.each([
    ['Petrocas Fuel Services Georgia LLC', 'petrocas fuel services georgia'],
    ['Wells Fargo Bank, N.A.', 'wells fargo bank'],
    ['შპს კამექს ეარლაინს', 'კამექს ეარლაინს'],
  ])('%s → %s (task examples)', (name, key) => {
    expect(vendorKey(name)).toBe(key);
  });

  it('lowercases, removes punctuation and collapses whitespace', () => {
    expect(vendorKey('  AEG   Fuels\tIreland  ')).toBe('aeg fuels ireland');
    expect(vendorKey('Aviation Services Management (FZE)')).toBe('aviation services management');
    expect(vendorKey("O'Brien Aviation")).toBe('obrien aviation');
    expect(vendorKey('XYZ FZ-LLC')).toBe('xyz');
  });

  it('removes trailing legal forms repeatedly, but only trailing ones', () => {
    expect(vendorKey('Acme Co. Ltd')).toBe('acme');
    expect(vendorKey('Acme Holding Company Limited')).toBe('acme holding');
    expect(vendorKey('Smith & Co.')).toBe('smith');
    expect(vendorKey('AG Air Services GmbH')).toBe('ag air services');
    expect(vendorKey('LLC Holdings Inc.')).toBe('llc holdings');
    expect(vendorKey('Banco do Brasil SA')).toBe('banco do brasil');
  });

  it('removes a leading შპს or (Cyrillic) ООО, not a Latin one', () => {
    expect(vendorKey('ООО "Ромашка"')).toBe('ромашка');
    expect(vendorKey('შპს პეტროკასი')).toBe('პეტროკასი');
    expect(vendorKey('OOO Romashka')).toBe('ooo romashka');
    expect(vendorKey('Romashka OOO')).toBe('romashka');
  });

  it('is empty for a legal form alone', () => {
    expect(vendorKey('LLC')).toBe('');
    expect(vendorKey('Co., Ltd.')).toBe('');
    expect(vendorKey('')).toBe('');
  });
});

describe('invoiceNumberKey', () => {
  it('uppercases and removes spaces', () => {
    expect(invoiceNumberKey('si-000218719')).toBe('SI-000218719');
    expect(invoiceNumberKey(' PFSG CAM 0000 0000 510 ')).toBe('PFSGCAM00000000510');
    expect(invoiceNumberKey('3110713')).toBe('3110713');
  });
});

describe('bankAccountKey', () => {
  it('uses the normalized IBAN first', () => {
    expect(
      bankAccountKey({ iban: 'ge71 tb76-9203 6030 1000 01', accountNumber: '4942312687' }),
    ).toBe('GE71TB7692036030100001');
  });

  it('else the account number without spaces, uppercase', () => {
    expect(bankAccountKey({ iban: null, accountNumber: '4942 3126 87' })).toBe('4942312687');
    expect(bankAccountKey({ iban: ' ', accountNumber: 'ab 12' })).toBe('AB12');
  });

  it('else null', () => {
    expect(bankAccountKey({ iban: null, accountNumber: null })).toBeNull();
    expect(bankAccountKey({ iban: '', accountNumber: '  ' })).toBeNull();
    expect(bankAccountKey(null)).toBeNull();
  });
});

describe('business dates', () => {
  it('businessToday is the calendar day in Asia/Tbilisi (UTC+4)', () => {
    expect(businessToday(at('2026-10-01T19:59:59Z'))).toBe('2026-10-01');
    expect(businessToday(at('2026-10-01T20:00:00Z'))).toBe('2026-10-02');
    expect(businessToday(at('2026-12-31T21:00:00Z'))).toBe('2027-01-01');
  });

  it('addDays and daysBetween work on calendar dates', () => {
    expect(addDays('2026-09-14', 7)).toBe('2026-09-21');
    expect(addDays('2026-09-16', 0)).toBe('2026-09-16');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-02', '2026-10-05')).toBe(3);
    expect(daysBetween('2026-10-02', '2026-09-30')).toBe(-2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});
