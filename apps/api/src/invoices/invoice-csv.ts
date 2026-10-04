import { decimalStringSchema } from '@camex/shared';

// CSV for Excel and Numbers (T05): UTF-8 with a BOM (so Excel reads Georgian text as UTF-8),
// comma-separated, RFC 4180 quoting, CRLF line ends.

/** A cell value; `amount` cells are decimal strings and may keep a leading minus. */
export type CsvCell = string | null | { amount: string | null };

const BOM = '\uFEFF';
const CRLF = '\r\n';

/** Excel treats a cell starting with one of these as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * One field. Vendor-controlled text that Excel would run as a formula gets a leading `'`; an
 * amount is exempt only while it is a plain decimal, so credit notes (`-120.50`) stay numbers.
 */
export function csvField(cell: CsvCell): string {
  const isAmount = cell !== null && typeof cell === 'object';
  const value = isAmount ? cell.amount : cell;
  if (value === null) return '';
  const numeric = isAmount && decimalStringSchema.safeParse(value).success;
  const safe = FORMULA_START.test(value) && !numeric ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The whole file: BOM, header, one CRLF-terminated line per row. */
export function csvDocument(header: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(','));
  return BOM + lines.map((line) => line + CRLF).join('');
}

/** `attachment` Content-Disposition for a generated ASCII filename. */
export function attachmentContentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}
