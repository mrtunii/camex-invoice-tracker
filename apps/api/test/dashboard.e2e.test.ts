import {
  type Clock,
  type Dashboard,
  type InvoiceFlag,
  addDays,
  dashboardSchema,
  invoiceListResponseSchema,
} from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK } from '../src/clock/clock.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  type TestApp,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  resetJobs,
  setToday,
} from './helpers.js';

const TODAY = '2026-10-02';

type DateField = 'invoiceDate' | 'dueDate' | 'disputeDeadline' | 'paidAt';

/** Invoice columns for a seeded row; calendar dates as 'YYYY-MM-DD'. */
type Seed = Omit<
  Partial<Prisma.InvoiceUncheckedCreateInput>,
  DateField | 'inboundEmailId' | 'flags'
> &
  Partial<Record<DateField, string | null>> & {
    receivedAt?: Date;
    flags?: Pick<InvoiceFlag, 'code' | 'severity' | 'message'>[];
  };

const dateColumn = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00Z`);

/** The 12 trend months ending with 2026-10 (the month of TODAY). */
const TREND_MONTHS = [
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
];

const emptyTrend = (months = TREND_MONTHS) =>
  months.map((month) => ({ month, invoiced: '0', invoicedCount: 0, paid: '0', paidCount: 0 }));

describe('GET /api/dashboard', () => {
  let t: TestApp;
  let cookie: string;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    await createUser(t.prisma, { email: 'clerk@camex.aero' });
    cookie = await login(t, 'clerk@camex.aero');
    setToday(t, TODAY);
    seq = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One invoice row (needs_review, extracted) with its own email. */
  async function seed(data: Seed = {}): Promise<string> {
    const n = ++seq;
    const { receivedAt, flags, invoiceDate, dueDate, disputeDeadline, paidAt, ...columns } = data;
    const email = await t.prisma.inboundEmail.create({
      data: {
        provider: 'manual',
        receivedAt: receivedAt ?? new Date(Date.UTC(2026, 8, 1, 6, 0, 0) + n * 60_000),
      },
    });
    const invoice = await t.prisma.invoice.create({
      data: {
        inboundEmailId: email.id,
        fileKey: `invoices/test/${String(n)}.pdf`,
        fileName: `invoice-${String(n)}.pdf`,
        fileSha256: `sha-${String(n)}`,
        fileSize: 1000,
        status: 'needs_review',
        extractionStatus: 'succeeded',
        flags: (flags ?? []).map((flag) => ({ ...flag, field: null })),
        invoiceDate: dateColumn(invoiceDate),
        dueDate: dateColumn(dueDate),
        disputeDeadline: dateColumn(disputeDeadline),
        paidAt: dateColumn(paidAt),
        ...columns,
      },
    });
    return invoice.id;
  }

  const get = (path: string) => t.http().get(path).set('Cookie', cookie);

  async function dashboard(query = ''): Promise<Dashboard> {
    const res = await get(`/api/dashboard${query === '' ? '' : `?${query}`}`).expect(200);
    // Strict at the top level; nested objects drop unknown keys, so toEqual catches extras.
    const parsed = dashboardSchema.strict().parse(res.body);
    expect(parsed).toEqual(res.body);
    return parsed;
  }

  async function listIds(query: string): Promise<string[]> {
    const res = await get(`/api/invoices?${query}`).expect(200);
    return invoiceListResponseSchema.parse(res.body).items.map((item) => item.id);
  }

  describe('access and validation', () => {
    it('requires a session (401)', async () => {
      for (const path of ['/api/dashboard', '/api/dashboard?month=2026-10']) {
        const res = await t.http().get(path).expect(401);
        expect(res.body.message).toBe('Not authenticated');
      }
    });

    it('refuses bad and unknown parameters (400)', async () => {
      for (const query of [
        'month=2026-13',
        'month=2026-00',
        'month=0000-01',
        'month=2026-1',
        'month=26-10',
        'month=abc',
        'month=2026-10-01',
        'month=2026-10&month=2026-09',
        'currency=US',
        'currency=US1',
        'currency=DOLLAR',
        'foo=1',
        'status=unpaid',
      ]) {
        const res = await get(`/api/dashboard?${query}`);
        expect(res.status, query).toBe(400);
        expect(res.body.message, query).toBe('Validation failed');
        expect(res.body.issues.length, query).toBeGreaterThan(0);
      }
    });
  });

  it('an empty database: nothing to do, the current month, no currency', async () => {
    expect(await dashboard()).toEqual({
      today: TODAY,
      month: '2026-10',
      currency: null,
      currencies: [],
      attention: {
        toReview: { count: 0, items: [] },
        toPay: { count: 0, items: [] },
        disputeSoonCount: 0,
        nextDisputeDeadline: null,
        overdueCount: 0,
        dueSoonCount: 0,
        extractionFailedCount: 0,
      },
      ledger: { currencies: [], invoiced: [], paid: [], toPay: [], toReview: [] },
      trend: emptyTrend(),
      categories: [],
      topVendors: [],
    });
  });

  describe('month ledger', () => {
    beforeEach(async () => {
      // September 2026 unless the name says otherwise.
      await seed({
        status: 'paid',
        invoiceDate: '2026-09-10',
        paidAt: '2026-09-20',
        amountDue: '100.1',
        amountDueCurrency: 'USD',
      });
      // Invoiced in September, paid in October: Paid of October, never To pay.
      await seed({
        status: 'paid',
        invoiceDate: '2026-09-25',
        paidAt: '2026-10-01',
        amountDue: '50',
        amountDueCurrency: 'USD',
      });
      // The first and last days of the month.
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-09-30',
        amountDue: '0.1',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-09-01',
        amountDue: '0.2',
        amountDueCurrency: 'USD',
      });
      // The neighbouring months.
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-10-01',
        amountDue: '7',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-08-31',
        amountDue: '9',
        amountDueCurrency: 'USD',
      });
      // Invoiced in August, paid in September (cash basis).
      await seed({
        status: 'paid',
        invoiceDate: '2026-08-15',
        paidAt: '2026-09-03',
        amountDue: '1000.5',
        amountDueCurrency: 'GEL',
      });
      await seed({
        status: 'paid',
        invoiceDate: '2026-09-17',
        paidAt: '2026-09-30',
        amountDue: '250.25',
        amountDueCurrency: 'GEL',
      });
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-09-18',
        amountDue: '-12.3456',
        amountDueCurrency: 'EUR',
      });
      // To review: not invoiced yet.
      await seed({
        status: 'needs_review',
        invoiceDate: '2026-09-12',
        amountDue: '88753.98',
        amountDueCurrency: 'GEL',
      });
      await seed({
        status: 'needs_review',
        invoiceDate: '2026-09-13',
        amountDue: '0.02',
        amountDueCurrency: 'GEL',
      });
      // Nowhere: processing, rejected, no amount, no currency, no invoice date.
      await seed({
        status: 'processing',
        extractionStatus: 'pending',
        invoiceDate: '2026-09-14',
        amountDue: '5',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'rejected',
        invoiceDate: '2026-09-14',
        amountDue: '5',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-09-15',
        amountDue: null,
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'paid',
        invoiceDate: '2026-09-16',
        paidAt: '2026-09-16',
        amountDue: '3',
        amountDueCurrency: null,
      });
      await seed({
        status: 'needs_review',
        invoiceDate: null,
        amountDue: '4',
        amountDueCurrency: 'USD',
      });
    });

    it('each row by its definition, per currency, with exact sums', async () => {
      const { month, ledger } = await dashboard('month=2026-09');
      expect(month).toBe('2026-09');
      expect(ledger).toEqual({
        currencies: ['EUR', 'GEL', 'USD'],
        invoiced: [
          { currency: 'EUR', amount: '-12.3456', count: 1 },
          { currency: 'GEL', amount: '250.25', count: 1 },
          { currency: 'USD', amount: '150.4', count: 4 },
        ],
        paid: [
          { currency: 'GEL', amount: '1250.75', count: 2 },
          { currency: 'USD', amount: '100.1', count: 1 },
        ],
        toPay: [
          { currency: 'EUR', amount: '-12.3456', count: 1 },
          { currency: 'USD', amount: '0.3', count: 2 }, // not 0.30000000000000004
        ],
        toReview: [{ currency: 'GEL', amount: '88754', count: 2 }],
      });
    });

    it('months are calendar months: the last day stays in its month, paid by payment date', async () => {
      // October (the default month): the 1 Oct invoice and the 1 Oct payment, not 30 Sep.
      expect((await dashboard()).ledger).toEqual({
        currencies: ['USD'],
        invoiced: [{ currency: 'USD', amount: '7', count: 1 }],
        paid: [{ currency: 'USD', amount: '50', count: 1 }],
        toPay: [{ currency: 'USD', amount: '7', count: 1 }],
        toReview: [],
      });
      expect((await dashboard('month=2026-08')).ledger).toEqual({
        currencies: ['GEL', 'USD'],
        invoiced: [
          { currency: 'GEL', amount: '1000.5', count: 1 },
          { currency: 'USD', amount: '9', count: 1 },
        ],
        paid: [],
        toPay: [{ currency: 'USD', amount: '9', count: 1 }],
        toReview: [],
      });
      expect((await dashboard('month=2025-01')).ledger).toEqual({
        currencies: [],
        invoiced: [],
        paid: [],
        toPay: [],
        toReview: [],
      });

      // Across a year end.
      await seed({
        status: 'paid',
        invoiceDate: '2025-12-31',
        paidAt: '2026-01-01',
        amountDue: '12.5',
        amountDueCurrency: 'USD',
      });
      expect((await dashboard('month=2025-12')).ledger).toMatchObject({
        invoiced: [{ currency: 'USD', amount: '12.5', count: 1 }],
        paid: [],
      });
      expect((await dashboard('month=2026-01')).ledger).toMatchObject({
        invoiced: [],
        paid: [{ currency: 'USD', amount: '12.5', count: 1 }],
      });
    });

    it('the default month follows Tbilisi, not UTC', async () => {
      vi.restoreAllMocks();
      const now = vi.spyOn(t.app.get<Clock>(CLOCK), 'now');
      // 21:30 UTC on 30 Sep is 01:30 on 1 Oct in Tbilisi (UTC+4).
      now.mockReturnValue(new Date('2026-09-30T21:30:00Z'));
      let result = await dashboard();
      expect(result).toMatchObject({ today: '2026-10-01', month: '2026-10' });
      expect(result.ledger.invoiced).toEqual([{ currency: 'USD', amount: '7', count: 1 }]);
      expect(result.trend.at(-1)?.month).toBe('2026-10');

      // 19:59 UTC on 30 Sep is still 23:59 on 30 Sep in Tbilisi.
      now.mockReturnValue(new Date('2026-09-30T19:59:59Z'));
      result = await dashboard();
      expect(result).toMatchObject({ today: '2026-09-30', month: '2026-09' });
      expect(result.ledger.toPay).toEqual([
        { currency: 'EUR', amount: '-12.3456', count: 1 },
        { currency: 'USD', amount: '0.3', count: 2 },
      ]);
      expect(result.trend.map((m) => m.month)).toEqual(['2025-10', ...TREND_MONTHS.slice(0, -1)]);
    });
  });

  describe('trend and currency', () => {
    it('12 months, oldest first, ending with the current month; empty months are zero', async () => {
      const invoiced = (invoiceDate: string, amountDue: string, extra: Seed = {}) =>
        seed({ status: 'unpaid', invoiceDate, amountDue, amountDueCurrency: 'USD', ...extra });
      await invoiced('2025-10-31', '1000'); // the 13th month back: outside
      await invoiced('2025-11-01', '10.5'); // the first trend month
      await invoiced('2026-03-10', '0.1');
      await invoiced('2026-03-31', '0.2');
      await invoiced('2026-10-02', '5');
      await seed({
        status: 'paid',
        invoiceDate: '2026-02-20',
        paidAt: '2026-03-05',
        amountDue: '20',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'paid',
        invoiceDate: '2025-09-01',
        paidAt: '2025-11-30',
        amountDue: '1.25',
        amountDueCurrency: 'USD',
      });
      // Not invoiced, other currencies, nothing to sum.
      await invoiced('2026-04-01', '999', { status: 'needs_review' });
      await invoiced('2026-04-01', '999', { status: 'rejected' });
      await invoiced('2026-04-01', '999', { amountDueCurrency: 'GEL' });
      await invoiced('2026-04-01', '999', { amountDue: null });

      const expected = emptyTrend().map((month) => {
        switch (month.month) {
          case '2025-11':
            return { ...month, invoiced: '10.5', invoicedCount: 1, paid: '1.25', paidCount: 1 };
          case '2026-02':
            return { ...month, invoiced: '20', invoicedCount: 1 };
          case '2026-03':
            return { ...month, invoiced: '0.3', invoicedCount: 2, paid: '20', paidCount: 1 };
          case '2026-10':
            return { ...month, invoiced: '5', invoicedCount: 1 };
          default:
            return month;
        }
      });
      const result = await dashboard();
      expect(result.currency).toBe('USD');
      expect(result.trend).toEqual(expected);
      // The month parameter moves the ledger, not the trend.
      expect((await dashboard('month=2025-01')).trend).toEqual(expected);
      expect((await dashboard('month=2026-03')).trend).toEqual(expected);
      // Another currency has its own trend.
      const gel = await dashboard('currency=GEL');
      expect(gel.trend).toEqual(
        emptyTrend().map((month) =>
          month.month === '2026-04' ? { ...month, invoiced: '999', invoicedCount: 1 } : month,
        ),
      );
    });

    it('defaults to the currency with the most invoiced invoices in the period', async () => {
      const invoiced = (amountDueCurrency: string, amountDue: string, extra: Seed = {}) =>
        seed({
          status: 'unpaid',
          invoiceDate: '2026-06-15',
          amountDue,
          amountDueCurrency,
          ...extra,
        });
      // GEL: three small invoices. USD: two large ones. The count wins, not the amount.
      await invoiced('GEL', '1');
      await invoiced('GEL', '2', { status: 'paid', paidAt: '2026-07-01' });
      await invoiced('GEL', '3');
      await invoiced('USD', '100000');
      await invoiced('USD', '200000');
      // Not counted: outside the period, not invoiced, no amount.
      for (let i = 0; i < 5; i++) await invoiced('EUR', '1', { invoiceDate: '2025-10-31' });
      for (let i = 0; i < 5; i++) await invoiced('AED', '1', { status: 'needs_review' });
      for (let i = 0; i < 5; i++) await invoiced('CHF', '1', { status: 'rejected' });
      for (let i = 0; i < 5; i++) await invoiced('GBP', '1', { amountDue: null });

      let result = await dashboard();
      expect(result.currency).toBe('GEL');
      expect(result.currencies).toEqual(['GEL', 'USD']);

      // A tie goes to the alphabetically first code.
      await invoiced('USD', '1');
      result = await dashboard();
      expect(result.currency).toBe('GEL');
      expect(result.currencies).toEqual(['GEL', 'USD']);

      await invoiced('USD', '1');
      result = await dashboard();
      expect(result.currency).toBe('USD');
      expect(result.currencies).toEqual(['USD', 'GEL']);
    });

    it('honours an explicit currency (any case), even without data', async () => {
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-10-01',
        amountDue: '10',
        amountDueCurrency: 'USD',
        category: 'fuel',
        vendorName: 'AEG',
      });
      await seed({
        status: 'unpaid',
        invoiceDate: '2026-10-01',
        amountDue: '20',
        amountDueCurrency: 'GEL',
        category: 'catering',
        vendorName: 'SkyChef',
      });

      const gel = await dashboard('currency=gel');
      expect(gel.currency).toBe('GEL');
      expect(gel.currencies).toEqual(['GEL', 'USD']); // 1 each: alphabetical
      expect(gel.categories).toEqual([{ category: 'catering', amount: '20', count: 1 }]);
      expect(gel.topVendors).toEqual([{ name: 'SkyChef', amount: '20', count: 1 }]);
      expect(gel.trend.at(-1)).toMatchObject({ invoiced: '20', invoicedCount: 1 });

      const eur = await dashboard('currency=EUR');
      expect(eur.currency).toBe('EUR');
      expect(eur.currencies).toEqual(['GEL', 'USD']);
      expect(eur.trend).toEqual(emptyTrend());
      expect(eur.categories).toEqual([]);
      expect(eur.topVendors).toEqual([]);
      // The ledger shows every currency whatever the selection.
      expect(eur.ledger.currencies).toEqual(['GEL', 'USD']);
    });
  });

  it('categories and top vendors: the month’s invoiced in the currency, top 5, ties', async () => {
    const vendor = await t.prisma.vendor.create({ data: { name: 'Alpha Fuel' } });
    const row = (category: Seed['category'], amountDue: string, extra: Seed = {}) =>
      seed({
        status: 'unpaid',
        invoiceDate: '2026-09-15',
        amountDue,
        amountDueCurrency: 'USD',
        category,
        ...extra,
      });
    await row('fuel', '299.99', { vendorId: vendor.id, vendorName: 'ALPHA FUEL TRADING LLC' });
    await row('fuel', '200.01', {
      vendorId: vendor.id,
      vendorName: null,
      status: 'paid',
      paidAt: '2026-09-30',
    });
    await row('ground_handling', '300', { vendorName: 'Delta Handling' });
    await row('airport_charges', '300', { vendorName: 'Charlie Airports' });
    await row(null, '300', { vendorName: null });
    await row('navigation', '250', { vendorName: 'Echo Navigation' });
    await row('catering', '100', { vendorName: 'Foxtrot Catering' });
    await row('maintenance', '100', { vendorName: 'Golf Maintenance' });
    await row('crew', '50', { vendorName: 'Hotel Crew' });
    // Not counted: another currency, not invoiced, another month.
    await row('fuel', '99999', { vendorName: 'Big', amountDueCurrency: 'GEL' });
    await row('crew', '99999', { vendorName: 'Big', status: 'needs_review' });
    await row('crew', '99999', { vendorName: 'Big', status: 'rejected' });
    await row('crew', '99999', { vendorName: 'Big', invoiceDate: '2026-08-31' });
    await row('crew', '99999', { vendorName: 'Big', invoiceDate: '2026-10-01' });

    const result = await dashboard('month=2026-09&currency=USD');
    expect(result.categories).toEqual([
      { category: 'fuel', amount: '500', count: 2 },
      // 300 each: alphabetical by code, unclassified last.
      { category: 'airport_charges', amount: '300', count: 1 },
      { category: 'ground_handling', amount: '300', count: 1 },
      { category: null, amount: '300', count: 1 },
      { category: 'navigation', amount: '250', count: 1 },
    ]);
    expect(result.topVendors).toEqual([
      // The linked vendor's name, whatever the invoice says.
      { name: 'Alpha Fuel', amount: '500', count: 2 },
      { name: 'Charlie Airports', amount: '300', count: 1 },
      { name: 'Delta Handling', amount: '300', count: 1 },
      { name: 'Unknown vendor', amount: '300', count: 1 },
      { name: 'Echo Navigation', amount: '250', count: 1 },
    ]);

    const gel = await dashboard('month=2026-09&currency=GEL');
    expect(gel.categories).toEqual([{ category: 'fuel', amount: '99999', count: 1 }]);
    expect(gel.topVendors).toEqual([{ name: 'Big', amount: '99999', count: 1 }]);
  });

  describe('attention', () => {
    const due = (offset: number) => addDays(TODAY, offset);

    it('panels: counts, at most 5 rows each, in the list tabs’ default order', async () => {
      const review: string[] = [];
      for (const [i, deadline] of [
        due(5),
        null,
        due(-2),
        due(1),
        null,
        due(1),
        due(30),
      ].entries()) {
        review.push(
          await seed({
            status: i === 1 ? 'processing' : 'needs_review',
            extractionStatus: i === 1 ? 'pending' : 'succeeded',
            disputeDeadline: deadline,
            receivedAt: new Date(Date.UTC(2026, 8, 1, 6, 30 - i)),
          }),
        );
      }
      const toPay: string[] = [];
      for (const dueDate of [due(3), null, due(-10), due(3), due(20), due(0), due(-1)]) {
        toPay.push(await seed({ status: 'unpaid', dueDate }));
      }
      await seed({ status: 'paid', dueDate: due(-30), paidAt: due(-1) });
      await seed({ status: 'rejected', disputeDeadline: due(0) });

      const { attention } = await dashboard();
      expect(attention.toReview.count).toBe(7);
      expect(attention.toPay.count).toBe(7);
      const reviewIds = attention.toReview.items.map((item) => item.id);
      const payIds = attention.toPay.items.map((item) => item.id);
      expect(reviewIds).toEqual(await listIds('status=needs_review&pageSize=5'));
      expect(payIds).toEqual(await listIds('status=unpaid&pageSize=5'));
      // Spelled out: deadline asc (ties by received), nulls last by received.
      expect(reviewIds).toEqual([review[2], review[5], review[3], review[0], review[6]]);
      expect(payIds).toEqual([toPay[2], toPay[6], toPay[5], toPay[0], toPay[3]]);
      // Processing rows count as To review (here the last, without a deadline).
      expect((await listIds('status=needs_review&pageSize=200')).at(-1)).toBe(review[1]);
    });

    it('item shape: vendor name, amount as stored, dates, the first error message', async () => {
      const vendor = await t.prisma.vendor.create({ data: { name: 'AEG Fuels' } });
      const linked = await seed({
        vendorId: vendor.id,
        vendorName: 'AEG Fuels Ireland Limited',
        amountDue: '6461.2900',
        amountDueCurrency: 'USD',
        dueDate: '2026-09-21',
        disputeDeadline: '2026-10-03',
        flags: [
          { code: 'MISSING_REQUIRED', severity: 'error', message: 'Due date is missing' },
          { code: 'TOTAL_MATH', severity: 'error', message: 'Line items add up to 1.00' },
          { code: 'DISPUTE_SOON', severity: 'warning', message: 'Dispute window ends 2026-10-03' },
        ],
      });
      const unlinked = await seed({
        status: 'needs_review',
        extractionStatus: 'failed',
        vendorName: null,
        disputeDeadline: '2026-10-04',
        flags: [{ code: 'NEW_VENDOR', severity: 'info', message: 'No vendor matched' }],
      });
      const pay = await seed({
        status: 'unpaid',
        vendorName: 'Petrocas Fuel Services Georgia LLC',
        amountDue: '88753.98',
        amountDueCurrency: 'GEL',
        dueDate: '2026-10-09',
        flags: [{ code: 'BANK_FIRST_SEEN', severity: 'warning', message: 'First bank details' }],
      });

      const { attention } = await dashboard();
      expect(attention.toReview.items).toEqual([
        {
          id: linked,
          status: 'needs_review',
          extractionStatus: 'succeeded',
          vendorName: 'AEG Fuels',
          amountDue: '6461.29',
          amountDueCurrency: 'USD',
          dueDate: '2026-09-21',
          disputeDeadline: '2026-10-03',
          errorMessage: 'Due date is missing',
        },
        {
          id: unlinked,
          status: 'needs_review',
          extractionStatus: 'failed',
          vendorName: null,
          amountDue: null,
          amountDueCurrency: null,
          dueDate: null,
          disputeDeadline: '2026-10-04',
          errorMessage: null, // info only
        },
      ]);
      expect(attention.toPay.items).toEqual([
        {
          id: pay,
          status: 'unpaid',
          extractionStatus: 'succeeded',
          vendorName: 'Petrocas Fuel Services Georgia LLC',
          amountDue: '88753.98',
          amountDueCurrency: 'GEL',
          dueDate: '2026-10-09',
          disputeDeadline: null,
          errorMessage: null, // warnings only
        },
      ]);
    });

    it('dispute window: needs_review, today … today + 3', async () => {
      await seed({ disputeDeadline: due(-1) }); // passed: the list shows it, Home's count doesn't
      await seed({ disputeDeadline: due(4) });
      await seed({ disputeDeadline: null });
      await seed({ status: 'unpaid', disputeDeadline: due(0) });
      await seed({ status: 'paid', disputeDeadline: due(0), paidAt: due(-1) });
      await seed({ status: 'rejected', disputeDeadline: due(0) });
      let { attention } = await dashboard();
      expect(attention).toMatchObject({ disputeSoonCount: 0, nextDisputeDeadline: null });

      await seed({ disputeDeadline: due(3) });
      ({ attention } = await dashboard());
      expect(attention).toMatchObject({ disputeSoonCount: 1, nextDisputeDeadline: due(3) });

      await seed({ disputeDeadline: due(0) });
      await seed({ disputeDeadline: due(2) });
      ({ attention } = await dashboard());
      expect(attention).toMatchObject({ disputeSoonCount: 3, nextDisputeDeadline: due(0) });

      // Tomorrow, today's deadline has passed and the +4 one is inside the window.
      vi.restoreAllMocks();
      setToday(t, due(1));
      ({ attention } = await dashboard());
      expect(attention).toMatchObject({ disputeSoonCount: 3, nextDisputeDeadline: due(2) });
    });

    it('overdue and due soon: unpaid, before today / today … today + 7 (the list’s due filter)', async () => {
      await seed({ status: 'unpaid', dueDate: due(-30) });
      await seed({ status: 'unpaid', dueDate: due(-1) });
      await seed({ status: 'unpaid', dueDate: due(0) });
      await seed({ status: 'unpaid', dueDate: due(7) });
      await seed({ status: 'unpaid', dueDate: due(8) });
      await seed({ status: 'unpaid', dueDate: null });
      await seed({ status: 'needs_review', dueDate: due(-1) });
      await seed({ status: 'needs_review', dueDate: due(1) });
      await seed({ status: 'paid', dueDate: due(-1), paidAt: due(-2) });
      await seed({ status: 'paid', dueDate: due(1), paidAt: due(-2) });

      const { attention } = await dashboard();
      expect(attention).toMatchObject({ overdueCount: 2, dueSoonCount: 2 });
      expect(attention.overdueCount).toBe((await listIds('status=unpaid&due=overdue')).length);
      expect(attention.dueSoonCount).toBe((await listIds('status=unpaid&due=soon')).length);
    });

    it('extraction failures: needs_review only', async () => {
      await seed({ extractionStatus: 'failed' });
      await seed({ extractionStatus: 'failed' });
      await seed({ extractionStatus: 'succeeded' });
      await seed({ status: 'processing', extractionStatus: 'pending' });
      await seed({ status: 'rejected', extractionStatus: 'failed' });
      await seed({ status: 'unpaid', extractionStatus: 'failed' });

      const { attention } = await dashboard();
      expect(attention.extractionFailedCount).toBe(2);
      expect(attention.toReview.count).toBe(4);
    });
  });
});
