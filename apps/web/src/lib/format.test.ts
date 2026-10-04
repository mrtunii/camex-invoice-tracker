// Unit tests for lib/format.ts. `pnpm --filter @camex/web test` (Node's test runner, as for
// docker/app-config.test.ts). node:test's describe/it return promises the runner awaits itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAmount, formatDate, formatMoney, formatTimestamp } from './format.ts';

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
  void it('puts the currency code first and never converts', () => {
    assert.equal(formatAmount('22079.08', 'USD'), 'USD 22,079.08');
    assert.equal(formatAmount('88753.98', 'GEL'), 'GEL 88,753.98');
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
