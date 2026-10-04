// The invoice's activity log as plain sentences (T06 §3.6). Pure functions over the events API,
// tested with Node's runner (activity.test.ts); no `@/` imports. Flag codes never appear.
import {
  type BankDetails,
  type ExtractedLineItem,
  type InvoiceEvent,
  approvedEventDataSchema,
  bankDetailsSchema,
  editedEventDataSchema,
  extractedLineItemSchema,
  extractionFailedEventDataSchema,
  paidEventDataSchema,
  paymentUndoneEventDataSchema,
  receivedEventDataSchema,
  rejectedEventDataSchema,
  reopenedEventDataSchema,
  vendorLinkedEventDataSchema,
} from '@camex/shared';
import { z } from 'zod';
import { formatDate, formatEventTime, formatMoney, plural } from './format.ts';
import {
  BANK_FIELD_LABELS,
  CATEGORY_LABELS,
  DOCUMENT_TYPE_LABELS,
  FIELD_LABELS,
  LINE_KIND_LABELS,
  OVERRIDDEN_FLAG_WORDS,
  REJECTION_REASON_LABELS,
} from './invoice-labels.ts';

/** One changed value: "IBAN: GB29… → GB33…". */
export interface ActivityChange {
  label: string;
  from: string;
  to: string;
  /** Identifiers (IBAN, account numbers) are shown in Mono. */
  mono?: boolean;
}

export interface ActivityEntry {
  id: string;
  /** "Nino approved", "Otto changed Amount due from 6,461.29 to 6,416.29", "Matched to AEG Fuels by name". */
  text: string;
  /** "3 Oct, 14:02" in Tbilisi time (with the year when it isn't this year). */
  when: string;
  /** A note, a rejection reason or an error message, under the sentence. */
  note: string | null;
  /** One line per field when several changed, under the sentence. */
  changes: ActivityChange[];
  /** Line item and bank detail values, behind "Show". */
  details: ActivityChange[];
}

const MONEY_FIELDS = new Set(['subtotalAmount', 'taxAmount', 'totalAmount', 'amountDue']);
const DATE_FIELDS = new Set(['invoiceDate', 'serviceDate', 'dueDate']);
const DAY_FIELDS = new Set(['paymentTermsDays', 'disputeWindowDays']);
const MONO_FIELDS = new Set(['invoiceNumber', 'aircraftRegistration', 'flightNumbers']);
const MONO_BANK_FIELDS = new Set(['iban', 'accountNumber', 'swift', 'routingNumber']);

const EMPTY = '—';

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function labelOf(field: string): string {
  return field in FIELD_LABELS ? FIELD_LABELS[field as keyof typeof FIELD_LABELS] : field;
}

/** A stored value as people read it: money with separators, dates as '16 Sep 2026', labels for enums. */
export function formatFieldValue(field: string, value: unknown): string {
  if (isEmpty(value)) return EMPTY;
  if (typeof value === 'string') {
    if (MONEY_FIELDS.has(field)) return formatMoney(value);
    if (DATE_FIELDS.has(field)) return formatDate(value);
    if (field === 'documentType' && value in DOCUMENT_TYPE_LABELS) {
      return DOCUMENT_TYPE_LABELS[value as keyof typeof DOCUMENT_TYPE_LABELS];
    }
    if (field === 'category' && value in CATEGORY_LABELS) {
      return CATEGORY_LABELS[value as keyof typeof CATEGORY_LABELS];
    }
    return value;
  }
  if (typeof value === 'number' && DAY_FIELDS.has(field)) return plural(value, 'day', 'days');
  if (Array.isArray(value)) return value.map(String).join(', ');
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

const lineItemsSchema = z.array(extractedLineItemSchema);

function describeLine(line: ExtractedLineItem | undefined): string {
  if (line === undefined) return EMPTY;
  const quantity =
    line.quantity === null ? null : `${line.quantity}${line.uom === null ? '' : ` ${line.uom}`}`;
  const math = [quantity, line.unitPrice].filter((part) => part !== null).join(' × ');
  const amount = line.amount === null ? null : formatMoney(line.amount);
  const figures = [math === '' ? null : math, amount].filter((p) => p !== null).join(' = ');
  const kind = line.kind === 'item' ? '' : `${LINE_KIND_LABELS[line.kind]}: `;
  return [`${kind}${line.description ?? 'No description'}`, figures].filter(Boolean).join(' · ');
}

function lineItemChanges(from: unknown, to: unknown): { summary: string; rows: ActivityChange[] } {
  const before = lineItemsSchema.safeParse(from ?? []);
  const after = lineItemsSchema.safeParse(to ?? []);
  const a = before.success ? before.data : [];
  const b = after.success ? after.data : [];
  const rows: ActivityChange[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [describeLine(a[i]), describeLine(b[i])];
    if (x !== y) rows.push({ label: `Line ${String(i + 1)}`, from: x, to: y });
  }
  const counts =
    a.length === b.length ? '' : ` (${plural(a.length, 'line', 'lines')} → ${String(b.length)})`;
  return { summary: `line items${counts}`, rows };
}

const bankSchema = bankDetailsSchema.nullable();
const BANK_KEYS = Object.keys(BANK_FIELD_LABELS) as (keyof BankDetails)[];

function bankChanges(from: unknown, to: unknown): { summary: string; rows: ActivityChange[] } {
  const before = bankSchema.safeParse(from ?? null);
  const after = bankSchema.safeParse(to ?? null);
  const a = before.success ? before.data : null;
  const b = after.success ? after.data : null;
  const rows = BANK_KEYS.flatMap((key): ActivityChange[] => {
    const [x, y] = [a?.[key] ?? null, b?.[key] ?? null];
    if (x === y) return [];
    return [
      {
        label: BANK_FIELD_LABELS[key],
        from: x ?? EMPTY,
        to: y ?? EMPTY,
        mono: MONO_BANK_FIELDS.has(key),
      },
    ];
  });
  return { summary: `bank details: ${listOf(rows.map((row) => row.label))}`, rows };
}

function editedEntry(
  who: string,
  data: unknown,
): Pick<ActivityEntry, 'text' | 'changes' | 'details'> {
  const parsed = editedEventDataSchema.safeParse(data);
  if (!parsed.success) return { text: `${who} edited the invoice`, changes: [], details: [] };

  const scalars: ActivityChange[] = [];
  const summaries: string[] = [];
  const details: ActivityChange[] = [];
  for (const [field, change] of Object.entries(parsed.data)) {
    if (field === 'lineItems' || field === 'bankDetails') {
      const { summary, rows } =
        field === 'lineItems'
          ? lineItemChanges(change.from, change.to)
          : bankChanges(change.from, change.to);
      summaries.push(summary);
      details.push(...rows);
    } else {
      scalars.push({
        label: labelOf(field),
        from: formatFieldValue(field, change.from),
        to: formatFieldValue(field, change.to),
        mono: MONO_FIELDS.has(field),
      });
    }
  }

  const [only] = scalars;
  if (only !== undefined && scalars.length === 1 && summaries.length === 0) {
    const text =
      only.from === EMPTY
        ? `${who} set ${only.label} to ${only.to}`
        : only.to === EMPTY
          ? `${who} cleared ${only.label} (was ${only.from})`
          : `${who} changed ${only.label} from ${only.from} to ${only.to}`;
    return { text, changes: [], details };
  }
  const changed = [...scalars.map((s) => s.label), ...summaries];
  return {
    text: changed.length === 0 ? `${who} edited the invoice` : `${who} changed ${listOf(changed)}`,
    changes: scalars.length > 1 || summaries.length > 0 ? scalars : [],
    details,
  };
}

/** "bank details that differ from the ones on file and a duplicate invoice number". */
function overriddenWords(codes: readonly string[]): string {
  const words = codes.map((code) =>
    code in OVERRIDDEN_FLAG_WORDS
      ? (OVERRIDDEN_FLAG_WORDS[code as keyof typeof OVERRIDDEN_FLAG_WORDS] ?? 'an error flag')
      : 'an error flag',
  );
  return listOf([...new Set(words)]);
}

const VENDOR_MATCH: Record<'name' | 'alias' | 'email_domain', string> = {
  name: 'by name',
  alias: 'by an alias',
  email_domain: "by the sender's email domain",
};

/** One event as a sentence. `today` ('YYYY-MM-DD', Tbilisi) decides whether the year is shown. */
export function activityEntry(event: InvoiceEvent, today: string): ActivityEntry {
  const who = event.user?.name ?? 'Someone';
  const vendor = event.vendor?.name ?? 'a vendor';
  const base = {
    id: event.id,
    when: formatEventTime(event.at, today),
    note: null,
    changes: [],
    details: [],
  };
  const { data } = event;

  switch (event.type) {
    case 'received': {
      const parsed = receivedEventDataSchema.safeParse(data);
      const manual = parsed.success && parsed.data.source === 'manual';
      return {
        ...base,
        text: manual ? `${event.user ? who : 'Someone'} uploaded the PDF` : 'Received by email',
      };
    }
    case 'extracted':
      return { ...base, text: 'Read the PDF' };
    case 'extraction_failed': {
      const parsed = extractionFailedEventDataSchema.safeParse(data);
      return {
        ...base,
        text: "Couldn't read the PDF",
        note: parsed.success ? parsed.data.error : null,
      };
    }
    case 'edited':
      return { ...base, ...editedEntry(who, data) };
    case 'approved': {
      const parsed = approvedEventDataSchema.safeParse(data);
      const overridden = parsed.success ? parsed.data.overriddenFlags : [];
      if (overridden.length === 0) return { ...base, text: `${who} approved` };
      return { ...base, text: `${who} approved despite ${overriddenWords(overridden)}` };
    }
    case 'rejected': {
      const parsed = rejectedEventDataSchema.safeParse(data);
      if (!parsed.success) return { ...base, text: `${who} rejected it` };
      const reason = REJECTION_REASON_LABELS[parsed.data.reason].toLowerCase();
      return {
        ...base,
        text:
          parsed.data.reason === 'other' ? `${who} rejected it` : `${who} rejected it: ${reason}`,
        note: parsed.data.note,
      };
    }
    case 'paid': {
      const parsed = paidEventDataSchema.safeParse(data);
      if (!parsed.success) return { ...base, text: `${who} marked it paid` };
      const { paidAt, reference, overriddenFlags = [] } = parsed.data;
      const ref = reference === null ? '' : ` · ref ${reference}`;
      const despite =
        overriddenFlags.length === 0 ? '' : ` despite ${overriddenWords(overriddenFlags)}`;
      return { ...base, text: `${who} marked it paid on ${formatDate(paidAt)}${ref}${despite}` };
    }
    case 'payment_undone': {
      const parsed = paymentUndoneEventDataSchema.safeParse(data);
      const was =
        parsed.success && parsed.data.previousPaidAt !== null
          ? ` of ${formatDate(parsed.data.previousPaidAt)}`
          : '';
      return { ...base, text: `${who} undid the payment${was}` };
    }
    case 'reopened': {
      const parsed = reopenedEventDataSchema.safeParse(data);
      const from = parsed.success
        ? parsed.data.from === 'unpaid'
          ? ' (it was approved)'
          : ' (it was rejected)'
        : '';
      return { ...base, text: `${who} reopened it for review${from}` };
    }
    case 'reextracted':
      return { ...base, text: `${who} asked for a fresh reading of the PDF` };
    case 'vendor_linked': {
      const parsed = vendorLinkedEventDataSchema.safeParse(data);
      if (parsed.success && parsed.data.method !== 'manual') {
        return { ...base, text: `Matched to ${vendor} ${VENDOR_MATCH[parsed.data.method]}` };
      }
      return { ...base, text: `${who} linked it to ${vendor}` };
    }
    case 'bank_account_trusted':
      return { ...base, text: `${who} trusted the bank details for ${vendor}` };
  }
}
