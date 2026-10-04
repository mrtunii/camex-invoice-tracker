// Unit tests for lib/format.ts. `pnpm --filter @camex/web test` (Node's test runner, as for
// docker/app-config.test.ts). node:test's describe/it return promises the runner awaits itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abbreviateAmount,
  addMonths,
  disputePhrase,
  dueCell,
  duePhrase,
  formatAmount,
  formatDate,
  formatDay,
  formatDayInSentence,
  formatMonth,
  formatMoney,
  formatTimestamp,
} from './format.ts';

void describe('formatMoney', () => {
  void it('keeps every digit of large and precise decimals (no JS number in between)', () => {
    assert.equal(formatMoney('12345678901234.5678'), '12,345,678,901,234.5678');
    // As a JS number this would print 12,345,678,901,234.568.
    assert.notEqual(Number('12345678901234.5678').toFixed(4), '12345678901234.5678');
    assert.equal(formatMoney('99999999999999.9999'), '99,999,999,999,999.9999');
    assert.equal(formatMoney('9007199254740993'), '9,007,199,254,740,993.00');
  });

  void it('shows at least 2 decimals and the stored precision beyond that, never rounding', () => {
    assert.equal(formatMoney('0.3'), '0.30');
    assert.equal(formatMoney('5'), '5.00');
    assert.equal(formatMoney('88753.98'), '88,753.98');
    assert.equal(formatMoney('2814.2691'), '2,814.2691');
    assert.equal(formatMoney('0.0001'), '0.0001');
    assert.equal(formatMoney('1234567.123456'), '1,234,567.123456');
    assert.equal(formatMoney('0.005'), '0.005');
  });

  void it('formats negative amounts (credit notes) and zero', () => {
    assert.equal(formatMoney('-120.5'), '-120.50');
    assert.equal(formatMoney('-15617.79'), '-15,617.79');
    assert.equal(formatMoney('0'), '0.00');
  });

  void it('returns anything that is not a plain decimal unchanged', () => {
    assert.equal(formatMoney('1e5'), '1e5');
    assert.equal(formatMoney('12,5'), '12,5');
    assert.equal(formatMoney(''), '');
  });
});

void describe('formatAmount', () => {
  void it('writes the amount, then the currency code, and never converts', () => {
    assert.equal(formatAmount('15617.79', 'USD'), '15,617.79 USD');
    assert.equal(formatAmount('88753.98', 'GEL'), '88,753.98 GEL');
    assert.equal(formatAmount('10', null), '10.00');
    assert.equal(formatAmount(null, 'USD'), '—');
  });
});

void describe('formatDate and formatTimestamp', () => {
  void it("formats calendar dates as '16 Sep 2026'", () => {
    assert.equal(formatDate('2026-09-16'), '16 Sep 2026');
    assert.equal(formatDate('2026-01-02'), '2 Jan 2026');
    assert.equal(formatDate(null), '—');
  });

  void it('shows timestamps in Tbilisi time (UTC+4)', () => {
    assert.equal(formatTimestamp('2026-09-15T21:30:00.000Z'), '16 Sep 2026, 01:30');
    assert.equal(formatTimestamp('2026-10-04T08:05:00Z'), '4 Oct 2026, 12:05');
    assert.equal(formatTimestamp(null), '—');
  });
});

// Sunday 4 October 2026 in Tbilisi.
const TODAY = '2026-10-04';

void describe('formatDay (relative dates)', () => {
  void it('names the days next to today', () => {
    assert.equal(formatDay('2026-10-04', TODAY), 'Today');
    assert.equal(formatDay('2026-10-05', TODAY), 'Tomorrow');
    assert.equal(formatDay('2026-10-03', TODAY), 'Yesterday');
  });

  void it('uses the weekday within 6 days either way, across a month end', () => {
    assert.equal(formatDay('2026-10-09', TODAY), 'Fri 9 Oct');
    assert.equal(formatDay('2026-10-10', TODAY), 'Sat 10 Oct');
    assert.equal(formatDay('2026-09-28', TODAY), 'Mon 28 Sep');
    assert.equal(formatDay('2026-11-02', '2026-10-30'), 'Mon 2 Nov');
  });

  void it('writes the full date further away, and a dash without a date', () => {
    assert.equal(formatDay('2026-10-11', TODAY), '11 Oct 2026');
    assert.equal(formatDay('2026-09-27', TODAY), '27 Sep 2026');
    assert.equal(formatDay('2025-10-04', TODAY), '4 Oct 2025');
    assert.equal(formatDay(null, TODAY), '—');
  });

  void it('reads inside a sentence', () => {
    assert.equal(formatDayInSentence('2026-10-05', TODAY), 'tomorrow');
    assert.equal(formatDayInSentence('2026-10-04', TODAY), 'today');
    // Non-breaking spaces inside the date, so it never wraps mid-date.
    assert.equal(formatDayInSentence('2026-10-06', TODAY), 'on Tue\u00a06\u00a0Oct');
    assert.equal(formatDayInSentence('2026-10-20', TODAY), 'on 20\u00a0Oct\u00a02026');
  });
});

void describe('due and dispute phrases', () => {
  void it('says how overdue an unpaid invoice is, in red', () => {
    assert.deepEqual(duePhrase('2026-09-16', TODAY), { text: 'Overdue 18 days', tone: 'warning' });
    assert.deepEqual(duePhrase('2026-10-03', TODAY), { text: 'Overdue 1 day', tone: 'warning' });
  });

  void it('is amber from today to 7 days ahead, then neutral', () => {
    assert.deepEqual(duePhrase('2026-10-04', TODAY), { text: 'Due today', tone: 'caution' });
    assert.deepEqual(duePhrase('2026-10-05', TODAY), { text: 'Due tomorrow', tone: 'caution' });
    assert.deepEqual(duePhrase('2026-10-09', TODAY), { text: 'Due Fri 9 Oct', tone: 'caution' });
    assert.deepEqual(duePhrase('2026-10-11', TODAY), { text: 'Due 11 Oct 2026', tone: 'caution' });
    assert.deepEqual(duePhrase('2026-10-12', TODAY), { text: 'Due 12 Oct 2026', tone: null });
  });

  void it('colours a due date cell only while the invoice waits for payment', () => {
    assert.deepEqual(dueCell('2026-10-01', TODAY, true), {
      text: 'Overdue 3 days',
      tone: 'warning',
    });
    assert.deepEqual(dueCell('2026-10-09', TODAY, true), { text: 'Fri 9 Oct', tone: 'caution' });
    assert.deepEqual(dueCell('2026-10-01', TODAY, false), { text: 'Thu 1 Oct', tone: null });
  });

  void it('dispute windows: red once closed, amber within 3 days', () => {
    assert.deepEqual(disputePhrase('2026-10-03', TODAY), {
      text: 'Dispute window closed yesterday',
      tone: 'warning',
    });
    assert.deepEqual(disputePhrase('2026-09-30', TODAY), {
      text: 'Dispute window closed 4 days ago',
      tone: 'warning',
    });
    assert.deepEqual(disputePhrase('2026-10-05', TODAY), {
      text: 'Dispute window closes tomorrow',
      tone: 'caution',
    });
    assert.deepEqual(disputePhrase('2026-10-07', TODAY), {
      text: 'Dispute window closes Wed 7 Oct',
      tone: 'caution',
    });
    assert.deepEqual(disputePhrase('2026-10-08', TODAY), {
      text: 'Dispute window closes Thu 8 Oct',
      tone: null,
    });
  });
});

void describe('months and chart axes', () => {
  void it('names and steps months', () => {
    assert.equal(formatMonth('2026-10'), 'October 2026');
    assert.equal(addMonths('2026-10', 1), '2026-11');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2026-10', -11), '2025-11');
  });

  void it('abbreviates axis amounts', () => {
    assert.equal(abbreviateAmount(0), '0');
    assert.equal(abbreviateAmount(950), '950');
    assert.equal(abbreviateAmount(1500), '1.5k');
    assert.equal(abbreviateAmount(56153.08), '56k');
    assert.equal(abbreviateAmount(1_250_000), '1.3M');
    assert.equal(abbreviateAmount(2_000_000), '2M');
  });
});
