import type {
  BankDetails,
  ExtractedInvoice,
  ExtractedLineItem,
  ExtractionOutputV1,
} from '@camex/shared';

// Wire → domain (T03 §5). Pure functions: the worker and the eval run the same code. Anything
// that doesn't survive its rule becomes null, so review sees an empty field, never a guess.

const DECIMAL = /^-?\d+(\.\d+)?$/;
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
 * silently changing the value.
 */
export function decimal(value: string): string | null {
  let compact = value.replace(SPACES, '');
  if (THOUSANDS_COMMAS.test(compact)) compact = compact.replaceAll(',', '');
  return DECIMAL.test(compact) ? compact : null;
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

function lineItem(line: ExtractionOutputV1['lineItems'][number]): ExtractedLineItem {
  return {
    kind: line.kind,
    description: text(line.description),
    quantity: decimal(line.quantity),
    uom: text(line.uom),
    unitPrice: decimal(line.unitPrice),
    amount: decimal(line.amount),
  };
}

/** Null when nothing is left; an account number that is just the IBAN again is dropped. */
export function bankDetails(details: ExtractionOutputV1['bankDetails']): BankDetails | null {
  const iban = compactUpper(details.iban, SPACES_AND_DASHES);
  const accountNumber = compactUpper(details.accountNumber);
  const result: BankDetails = {
    beneficiary: name(details.beneficiary),
    bankName: name(details.bankName),
    iban,
    accountNumber:
      accountNumber !== null && accountNumber.replace(SPACES_AND_DASHES, '') === iban
        ? null
        : accountNumber,
    swift: compactUpper(details.swift, SPACES_AND_DASHES),
    routingNumber: compactUpper(details.routingNumber),
    currency: currencyCode(details.currency),
  };
  return Object.values(result).every((value) => value === null) ? null : result;
}

export function normalizeExtraction(raw: ExtractionOutputV1): ExtractedInvoice {
  return {
    documentType: raw.documentType,
    vendorName: name(raw.vendorName),
    vendorTaxId: taxId(raw.vendorTaxId),
    billToName: name(raw.billToName),
    invoiceNumber: text(raw.invoiceNumber),
    invoiceDate: calendarDate(raw.invoiceDate),
    serviceDate: calendarDate(raw.serviceDate),
    dueDate: calendarDate(raw.dueDate),
    paymentTermsText: text(raw.paymentTermsText),
    paymentTermsDays: dayCount(raw.paymentTermsDays),
    disputeWindowDays: dayCount(raw.disputeWindowDays),
    category: raw.category,
    description: text(raw.description),
    airportIcao: icaoCode(raw.airportIcao),
    airportIata: iataCode(raw.airportIata),
    locationText: text(raw.locationText),
    aircraftRegistration: aircraftRegistration(raw.aircraftRegistration),
    flightNumbers: flightNumbers(raw.flightNumbers),
    currency: currencyCode(raw.currency),
    subtotalAmount: decimal(raw.subtotalAmount),
    taxAmount: decimal(raw.taxAmount),
    totalAmount: decimal(raw.totalAmount),
    amountDue: decimal(raw.amountDue),
    amountDueCurrency: currencyCode(raw.amountDueCurrency),
    lineItems: raw.lineItems.map(lineItem),
    bankDetails: bankDetails(raw.bankDetails),
    notes: text(raw.notes),
  };
}
