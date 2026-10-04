// Display formatting shared by every page. No `@/` imports, so the Node test runner can load it
// directly (`pnpm --filter @camex/web test`); package imports are fine.
import { DISPUTE_SOON_DAYS, DUE_SOON_DAYS } from '@camex/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar date 'YYYY-MM-DD' → '16 Sep 2026'. No time zone involved: it is a date, not a moment. */
export function formatDate(date: string | null): string {
  if (date === null) return '—';
  const [year, month, day] = date.split('-');
  return `${String(Number(day))} ${MONTHS[Number(month) - 1] ?? '?'} ${year ?? ''}`;
}

/** Business timezone (SPEC §3): timestamps are shown in Tbilisi time. */
const tbilisiParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tbilisi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function tbilisi(iso: string) {
  const parts = tbilisiParts.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

/** ISO timestamp → '16 Sep 2026, 14:05' in Tbilisi. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const { date, time } = tbilisi(iso);
  return `${formatDate(date)}, ${time}`;
}

/** ISO timestamp → its Tbilisi day (relative when close, see formatDay) and time, separately. */
export function formatTimestampParts(iso: string, today: string): { day: string; time: string } {
  const { date, time } = tbilisi(iso);
  return { day: formatDay(date, today), time };
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const moneyFormats = new Map<number, Intl.NumberFormat>();

/**
 * Decimal string → '12,345,678,901,234.5678': thousands separators, at least 2 decimals, and
 * every stored decimal beyond that. Never goes through a JS number: Intl.NumberFormat formats
 * a numeric string exactly (ES2023), so no precision is lost and nothing is rounded.
 */
export function formatMoney(amount: string): string {
  if (!DECIMAL.test(amount)) return amount;
  const decimals = Math.max(2, amount.split('.')[1]?.length ?? 0);
  let format = moneyFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimals,
    });
    moneyFormats.set(decimals, format);
  }
  return format.format(amount as `${number}`);
}

/** '15,617.79 USD': the amount, then the code, never a symbol; '—' without an amount. */
export function formatAmount(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  return currency === null ? formatMoney(amount) : `${formatMoney(amount)} ${currency}`;
}

/** A count with thousands separators: 1,234. */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** '1 invoice', '3 invoices'. */
export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

// ─── Relative dates ──────────────────────────────────────────────────────────
// Calendar dates near today read as words ("Tomorrow", "Fri 9 Oct"); the rest as '16 Sep 2026'.
// `today` is the business day in Tbilisi ('YYYY-MM-DD'), passed in so tests can pin it.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

function utcMs(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** Within this many days either side of today, a date reads as its weekday. */
const NEAR_DAYS = 6;

/** 'Today', 'Tomorrow', 'Yesterday', 'Fri 9 Oct' within 6 days either way, else '16 Sep 2026'. */
export function formatDay(date: string | null, today: string): string {
  if (date === null) return '—';
  const diff = dayDiff(today, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (Math.abs(diff) <= NEAR_DAYS) {
    const [, month, day] = date.split('-');
    const weekday = WEEKDAYS[new Date(utcMs(date)).getUTCDay()] ?? '';
    return `${weekday} ${String(Number(day))} ${MONTHS[Number(month) - 1] ?? '?'}`;
  }
  return formatDate(date);
}

/** formatDay for the middle of a sentence: 'today', 'tomorrow', 'on Fri 9 Oct', 'on 16 Sep 2026'. */
export function formatDayInSentence(date: string, today: string): string {
  const day = formatDay(date, today);
  // Non-breaking spaces: "Tue 6 Oct" stays on one line in a wrapping sentence.
  return day === 'Today' || day === 'Tomorrow' || day === 'Yesterday'
    ? day.toLowerCase()
    : `on ${day.replaceAll(' ', '\u00a0')}`;
}

/** Colour of a date by urgency (SPEC §10): red = act now, amber = act soon, null = neutral. */
export type Tone = 'warning' | 'caution' | null;

export interface DatePhrase {
  text: string;
  tone: Tone;
}

/** Red past the due date, amber from today to 7 days ahead (SPEC §6); unpaid invoices only. */
function dueTone(diff: number): Tone {
  if (diff < 0) return 'warning';
  return diff <= DUE_SOON_DAYS ? 'caution' : null;
}

/**
 * An unpaid invoice's due date as a phrase: 'Overdue 3 days' (red), 'Due today', 'Due tomorrow',
 * 'Due Fri 9 Oct' (amber, within 7 days), else 'Due 16 Oct 2026' (neutral).
 */
export function duePhrase(dueDate: string, today: string): DatePhrase {
  const diff = dayDiff(today, dueDate);
  if (diff < 0) return { text: `Overdue ${plural(-diff, 'day', 'days')}`, tone: 'warning' };
  const day = formatDay(dueDate, today);
  return { text: `Due ${diff <= 1 ? day.toLowerCase() : day}`, tone: dueTone(diff) };
}

/**
 * A due date in a "Due" column: 'Overdue 3 days' (red) or the day (amber within 7 days) while
 * the invoice waits for payment; just the day otherwise.
 */
export function dueCell(dueDate: string, today: string, unpaid: boolean): DatePhrase {
  const diff = dayDiff(today, dueDate);
  if (!unpaid) return { text: formatDay(dueDate, today), tone: null };
  if (diff < 0) return { text: `Overdue ${plural(-diff, 'day', 'days')}`, tone: 'warning' };
  return { text: formatDay(dueDate, today), tone: dueTone(diff) };
}

/**
 * A dispute deadline: 'Dispute window closed 2 days ago' (red), 'Dispute window closes
 * tomorrow' (amber, within 3 days), else 'Dispute window closes 16 Oct 2026' (neutral).
 */
export function disputePhrase(deadline: string, today: string): DatePhrase {
  const diff = dayDiff(today, deadline);
  if (diff < 0) {
    const ago = diff === -1 ? 'yesterday' : `${plural(-diff, 'day', 'days')} ago`;
    return { text: `Dispute window closed ${ago}`, tone: 'warning' };
  }
  const when = diff <= 1 ? formatDay(deadline, today).toLowerCase() : formatDay(deadline, today);
  return {
    text: `Dispute window closes ${when}`,
    tone: diff <= DISPUTE_SOON_DAYS ? 'caution' : null,
  };
}

// ─── Months ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** '2026-10' → 'October 2026'. */
export function formatMonth(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? '?'} ${year ?? ''}`;
}

/** '2026-10' → 'Oct'. */
export function formatShortMonth(month: string): string {
  return MONTHS[Number(month.split('-')[1]) - 1] ?? '?';
}

/** '2026-10' + 1 → '2026-11'; -1 → '2026-09'. */
export function addMonths(month: string, months: number): string {
  const [year = 0, m = 1] = month.split('-').map(Number);
  const index = year * 12 + (m - 1) + months;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * A chart axis value, rounded for reading: 950 → '950', 56153.08 → '56k', 1250000 → '1.3M'.
 * Only for axis ticks; amounts people read in full always go through formatMoney.
 */
export function abbreviateAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimZero((value / 1_000).toFixed(abs >= 10_000 ? 0 : 1))}k`;
  return trimZero(value.toFixed(0));
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
