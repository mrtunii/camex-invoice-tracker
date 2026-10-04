// Calendar dates are 'YYYY-MM-DD' strings end to end; "today" is the business day in Tbilisi.

/** SPEC §3: "today", overdue and the daily re-evaluation use this time zone. */
export const BUSINESS_TIME_ZONE = 'Asia/Tbilisi';

/** Injectable time source, so tests can move "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const businessDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in Asia/Tbilisi as 'YYYY-MM-DD'. */
export function businessToday(clock: Clock = systemClock): string {
  const parts = businessDayFormat.formatToParts(clock.now());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function toUtcMs(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** '2026-09-14' + 7 → '2026-09-21'. */
export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`: negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}
