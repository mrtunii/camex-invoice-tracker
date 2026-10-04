// Display formatting shared by every page. Kept free of imports so the Node test runner can load
// it directly (`pnpm --filter @camex/web test`).

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

/** ISO timestamp → its Tbilisi date and time, formatted separately (two-line table cells). */
export function formatTimestampParts(iso: string): { date: string; time: string } {
  const { date, time } = tbilisi(iso);
  return { date: formatDate(date), time };
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

/** 'USD 22,079.08'; '—' without an amount. */
export function formatAmount(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  return currency === null ? formatMoney(amount) : `${currency} ${formatMoney(amount)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
