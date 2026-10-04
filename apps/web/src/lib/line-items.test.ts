import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  lineTotals,
  readAmount,
  subtractDecimals,
  sumDecimals,
  withinTolerance,
} from './line-items.ts';

void describe('decimal helpers', () => {
  void it('adds exactly, at the largest scale (never through a float)', () => {
    assert.equal(sumDecimals(['0.1', '0.2']), '0.30');
    assert.equal(sumDecimals(['6459.42', '1.87']), '6461.29');
    assert.equal(sumDecimals(['1334.590', '0.0001']), '1334.5901');
    assert.equal(sumDecimals(['99999999999999.99', '0.01']), '100000000000000.00');
    assert.equal(sumDecimals(['-5', '2.5']), '-2.50');
    assert.equal(sumDecimals([]), '0.00');
  });

  void it('subtracts, keeping the sign', () => {
    assert.equal(subtractDecimals('6461.29', '6411.29'), '50.00');
    assert.equal(subtractDecimals('100', '100.004'), '-0.004');
    assert.equal(subtractDecimals('0.05', '0.1'), '-0.05');
  });

  void it('reads typed amounts like the API does ("" and junk are no amount)', () => {
    assert.equal(readAmount('6,416.29'), '6416.29');
    assert.equal(readAmount(' 12 '), '12');
    assert.equal(readAmount(''), null);
    assert.equal(readAmount('12,5'), null);
    assert.equal(readAmount(null), null);
  });

  void it('uses the SPEC §8 tolerance: max(0.05, 0.01 % of the expected amount)', () => {
    assert.equal(withinTolerance('100.05', '100'), true);
    assert.equal(withinTolerance('100.06', '100'), false);
    // 0.01 % of 1,000,000 is 100.
    assert.equal(withinTolerance('1000100', '1000000'), true);
    assert.equal(withinTolerance('1000100.01', '1000000'), false);
    assert.equal(withinTolerance('-99.96', '-100'), true);
  });
});

void describe('lineTotals', () => {
  void it('lines equal to the total match with a zero difference', () => {
    // AEG: two lines and three fees add up to the printed total.
    const totals = lineTotals(['6459.42', '0.40', '0.81', '0.33', '0.33'], '6461.29', '0');
    assert.deepEqual(totals, {
      lines: '6461.29',
      tax: null,
      sum: '6461.29',
      total: '6461.29',
      difference: '0.00',
      matches: true,
    });
  });

  void it('the tax closes the gap when the lines are net', () => {
    const totals = lineTotals(['1000.00', '200.00'], '1416.00', '216.00');
    assert.equal(totals.matches, true);
    assert.equal(totals.tax, '216.00');
    assert.equal(totals.sum, '1416.00');
    assert.equal(totals.difference, '0.00');
  });

  void it('a mismatch shows the closer of the two differences', () => {
    const net = lineTotals(['1000', '200'], '1420', '216');
    assert.equal(net.matches, false);
    assert.equal(net.tax, '216');
    assert.equal(net.difference, '4.00');

    const gross = lineTotals(['1000', '200'], '1190', '216');
    assert.equal(gross.matches, false);
    assert.equal(gross.tax, null);
    assert.equal(gross.difference, '-10.00');
  });

  void it('within tolerance still matches; the difference is exact', () => {
    const totals = lineTotals(['15617.75'], '15617.79', null);
    assert.equal(totals.matches, true);
    assert.equal(totals.difference, '0.04');
  });

  void it('skips lines without an amount or with an unreadable one', () => {
    const totals = lineTotals(['100', null, '', 'abc', '1,000.50'], '1100.50', null);
    assert.equal(totals.lines, '1100.50');
    assert.equal(totals.matches, true);
  });

  void it('nothing to compare without line amounts or without a total', () => {
    assert.deepEqual(lineTotals([null, ''], '100', null), {
      lines: null,
      tax: null,
      sum: null,
      total: '100',
      difference: null,
      matches: null,
    });
    const noTotal = lineTotals(['5'], null, null);
    assert.equal(noTotal.lines, '5.00');
    assert.equal(noTotal.difference, null);
    assert.equal(noTotal.matches, null);
  });
});
