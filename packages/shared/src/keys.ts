// Comparison keys (T04). Pure: the API matches and dedupes with them; the eval scorer reuses
// vendorKey for names.

/** Legal forms dropped from the end of a vendor name, repeatedly. */
const TRAILING_LEGAL_FORMS = new Set([
  'llc',
  'ltd',
  'limited',
  'fze',
  'fzco',
  'fzllc',
  'gmbh',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'llp',
  'sa',
  'srl',
  'sarl',
  'bv',
  'ag',
  'jsc',
  'ojsc',
  'cjsc',
  'ooo',
  'na',
]);

/** Georgian შპს and Russian ООО (both "LLC") come before the name. */
const LEADING_LEGAL_FORMS = new Set(['შპს', 'ооо']);

/** Unicode punctuation and symbols: removed, not replaced (N.A. → na, FZ-LLC → fzllc). */
const PUNCTUATION = /[\p{P}\p{S}]/gu;

/**
 * Vendor identity for matching and uniqueness: lowercase, punctuation removed, whitespace
 * collapsed, a leading "შპს"/"ооо" and trailing legal forms removed.
 * "Wells Fargo Bank, N.A." → "wells fargo bank". "" when nothing but a legal form is left.
 */
export function vendorKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(PUNCTUATION, '')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words[0] !== undefined && LEADING_LEGAL_FORMS.has(words[0])) words.shift();
  while (words.length > 0 && TRAILING_LEGAL_FORMS.has(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

/** Duplicate detection: uppercase, spaces removed ("si 000218719" → "SI000218719"). */
export function invoiceNumberKey(invoiceNumber: string): string {
  return invoiceNumber.replace(/\s/g, '').toUpperCase();
}

/** Spaces plus ASCII and Unicode dashes (as in the extraction's IBAN normalization). */
const SPACES_AND_DASHES = /[\s\-‐-―]/g;

/**
 * The account a payment goes to: the normalized IBAN, else the account number without spaces,
 * uppercase; null when neither is present. Bank details match when their keys are equal.
 */
export function bankAccountKey(
  details: { iban: string | null; accountNumber: string | null } | null,
): string | null {
  const iban = details?.iban?.replace(SPACES_AND_DASHES, '').toUpperCase() ?? '';
  if (iban !== '') return iban;
  const account = details?.accountNumber?.replace(/\s/g, '').toUpperCase() ?? '';
  return account === '' ? null : account;
}
