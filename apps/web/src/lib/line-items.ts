// Live totals under the line items table (T06). Exact decimal arithmetic on strings (BigInt at a
// common scale), never JS numbers: amounts are money. Pure, tested with Node's runner; no `@/`.
import { decimal } from '@camex/shared';

interface Scaled {
  units: bigint;
  scale: number;
}

function parse(value: string): Scaled {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(`${whole}${fraction}` || '0');
  return { units: negative ? -units : units, scale: fraction.length };
}

function atScale(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/** A typed amount as a plain decimal string ("6,416.29" → "6416.29"), or null if it isn't one. */
export function readAmount(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  return decimal(value);
}

/** Sum of decimal strings, at the largest scale among them (at least 2). */
export function sumDecimals(values: readonly string[]): string {
  const parsed = values.map(parse);
  const scale = Math.max(2, ...parsed.map((v) => v.scale));
  return format(
    parsed.reduce((acc, v) => acc + atScale(v, scale), 0n),
    scale,
  );
}

/** a − b, at the larger scale (at least 2). */
export function subtractDecimals(a: string, b: string): string {
  const [x, y] = [parse(a), parse(b)];
  const scale = Math.max(2, x.scale, y.scale);
  return format(atScale(x, scale) - atScale(y, scale), scale);
}

/**
 * SPEC §8 money tolerance: |actual − expected| ≤ max(0.05, 0.01 % of expected), i.e.
 * 10000·|diff| ≤ max(500, |expected|) in the same units.
 */
export function withinTolerance(actual: string, expected: string): boolean {
  const [a, e] = [parse(actual), parse(expected)];
  const scale = Math.max(2, a.scale, e.scale);
  const diff = atScale(a, scale) - atScale(e, scale);
  const expectedUnits = atScale(e, scale);
  const absDiff = diff < 0n ? -diff : diff;
  const absExpected = expectedUnits < 0n ? -expectedUnits : expectedUnits;
  const minimum = 500n * 10n ** BigInt(scale);
  return absDiff * 10000n <= (absExpected > minimum ? absExpected : minimum);
}

export interface LineTotals {
  /** Sum of the lines that have an amount; null when none has one. */
  lines: string | null;
  /** The tax added to the lines, when that is what makes them match the total. */
  tax: string | null;
  /** Lines (+ tax when it is part of the comparison). */
  sum: string | null;
  total: string | null;
  /** total − sum; null without both. */
  difference: string | null;
  /** Within the SPEC §8 tolerance (as TOTAL_MATH checks it); null when there is nothing to compare. */
  matches: boolean | null;
}

/**
 * What the table shows under the lines: their sum and the difference from the total. Like
 * TOTAL_MATH, the lines match when they equal the total on their own or with the tax added;
 * otherwise the smaller of the two differences is shown. Unreadable amounts are left out.
 */
export function lineTotals(
  amounts: readonly (string | null)[],
  totalAmount: string | null,
  taxAmount: string | null,
): LineTotals {
  const readable = amounts.map(readAmount).filter((a): a is string => a !== null);
  const total = readAmount(totalAmount);
  const tax = readAmount(taxAmount);
  const lines = readable.length === 0 ? null : sumDecimals(readable);
  if (lines === null || total === null) {
    return { lines, tax: null, sum: lines, total, difference: null, matches: null };
  }

  const plain = { tax: null, sum: lines, difference: subtractDecimals(total, lines) };
  if (withinTolerance(lines, total)) return { lines, total, ...plain, matches: true };
  if (tax === null) return { lines, total, ...plain, matches: false };

  const withTax = sumDecimals([lines, tax]);
  const taxed = { tax, sum: withTax, difference: subtractDecimals(total, withTax) };
  if (withinTolerance(withTax, total)) return { lines, total, ...taxed, matches: true };
  const closer = absLess(taxed.difference, plain.difference) ? taxed : plain;
  return { lines, total, ...closer, matches: false };
}

function absLess(a: string, b: string): boolean {
  const strip = (s: string) => (s.startsWith('-') ? s.slice(1) : s);
  const [x, y] = [parse(strip(a)), parse(strip(b))];
  const scale = Math.max(x.scale, y.scale);
  return atScale(x, scale) < atScale(y, scale);
}
