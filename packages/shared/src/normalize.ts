import type { BankDetails } from './extraction.js';

// Field normalization rules (T03 §5), shared by the extraction (wire → domain) and by edits
// (PATCH /api/invoices/:id, T06), so a value means the same whichever way it arrived. Pure
// functions over strings: a value that doesn't survive its rule becomes null.

const DECIMAL = /^-?\d+(\.\d+)?$/;
/** numeric(18,4) holds 14 digits before the point; a longer value can't be stored. */
export const MAX_INTEGER_DIGITS = 14;
/** 1,234 · 15,617.79 · -1,000,000.5 (commas only in thousands positions). */
const THOUSANDS_COMMAS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;
const ICAO = /^[A-Z]{4}$/;
const IATA = /^[A-Z]{3}$/;
const SPACES = /\s/g;
/** Spaces plus ASCII and Unicode dashes, for IBAN and SWIFT. */
const SPACES_AND_DASHES = /[\s\-‐-―]/g;

/** Trimmed; "" → null. */
export function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Like text(), with runs of whitespace collapsed to one space. */
export function name(value: string): string | null {
  return text(value.replace(/\s+/g, ' '));
}

/** 'YYYY-MM-DD' that exists in the calendar (2026-02-30 → null). */
export function calendarDate(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? trimmed : null;
}

/**
 * Decimal string as returned, never rounded. Spaces and thousands commas are stripped
 * defensively; a comma in any other position (a decimal comma) makes it null rather than
 * silently changing the value. More than 14 integer digits (leading zeros aside) is null too:
 * it wouldn't fit numeric(18,4), and review should see an empty field, not a failed write.
 */
export function decimal(value: string): string | null {
  let compact = value.replace(SPACES, '');
  if (THOUSANDS_COMMAS.test(compact)) compact = compact.replaceAll(',', '');
  if (!DECIMAL.test(compact)) return null;
  const integerDigits = (compact.replace(/^-/, '').split('.')[0] ?? '').replace(/^0+(?=\d)/, '');
  return integerDigits.length > MAX_INTEGER_DIGITS ? null : compact;
}

/** Digits after the decimal point ("6461.29" → 2). */
export function decimalPlaces(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

export function dayCount(value: string): number | null {
  const trimmed = value.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

function code(value: string, pattern: RegExp): string | null {
  const upper = value.trim().toUpperCase();
  return pattern.test(upper) ? upper : null;
}

export const currencyCode = (value: string): string | null => code(value, CURRENCY);
export const icaoCode = (value: string): string | null => code(value, ICAO);
export const iataCode = (value: string): string | null => code(value, IATA);

/** Uppercase with the given characters removed; "" → null. */
function compactUpper(value: string, strip: RegExp = SPACES): string | null {
  return text(value.replace(strip, '').toUpperCase());
}

export const taxId = (value: string): string | null => compactUpper(value);

/** Uppercase, no spaces or dashes: "GB29 NWBK-6016…" → "GB29NWBK6016…". */
export const iban = (value: string): string | null => compactUpper(value, SPACES_AND_DASHES);
export const swift = (value: string): string | null => compactUpper(value, SPACES_AND_DASHES);
/** Account and routing numbers: uppercase, no spaces (dashes kept: some banks print them). */
export const accountNumber = (value: string): string | null => compactUpper(value);

/** Uppercase, no spaces; Georgian `4L` registrations always get the hyphen (4LCMX → 4L-CMX). */
export function aircraftRegistration(value: string): string | null {
  const compact = compactUpper(value);
  if (compact === null) return null;
  return compact.replace(/^4L(?=[A-Z0-9])/, '4L-');
}

/**
 * One printed flight designator → flight numbers. A slash suffix of digits replaces the last
 * N digits of the base number (CMS503/4 → CMS503, CMS504; CMS503/504 → CMS503, CMS504);
 * a suffix that isn't all digits is taken as a flight number of its own.
 */
function expandFlightNumber(value: string): string[] {
  const [base = '', ...suffixes] = value.split('/');
  const match = /^(.*?)(\d+)$/.exec(base);
  if (!match) return [value];
  const [, prefix = '', digits = ''] = match;
  const numbers = [base];
  for (const suffix of suffixes) {
    if (suffix === '') continue;
    if (!/^\d+$/.test(suffix)) numbers.push(suffix);
    else if (suffix.length >= digits.length) numbers.push(prefix + suffix);
    else numbers.push(prefix + digits.slice(0, digits.length - suffix.length) + suffix);
  }
  return numbers;
}

/** Uppercase, no spaces, shorthand expanded, duplicates dropped, order kept. */
export function flightNumbers(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const compact = value.replace(SPACES, '').toUpperCase();
    if (compact === '') continue;
    for (const flight of expandFlightNumber(compact)) {
      if (!result.includes(flight)) result.push(flight);
    }
  }
  return result;
}

/** Bank details as text, `null` or "" for an absent value. */
export type BankDetailsText = Record<keyof BankDetails, string | null>;

/**
 * Null when nothing is left; an account number that is just the IBAN again is dropped. An
 * unrecognisable currency becomes null (the edit schema refuses it before it gets here).
 */
export function bankDetails(details: BankDetailsText): BankDetails | null {
  const s = (value: string | null) => value ?? '';
  const ibanValue = iban(s(details.iban));
  const account = accountNumber(s(details.accountNumber));
  const result: BankDetails = {
    beneficiary: name(s(details.beneficiary)),
    bankName: name(s(details.bankName)),
    iban: ibanValue,
    accountNumber:
      account !== null && account.replace(SPACES_AND_DASHES, '') === ibanValue ? null : account,
    swift: swift(s(details.swift)),
    routingNumber: accountNumber(s(details.routingNumber)),
    currency: currencyCode(s(details.currency)),
  };
  return Object.values(result).every((value) => value === null) ? null : result;
}
