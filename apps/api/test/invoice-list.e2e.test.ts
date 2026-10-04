import {
  type InvoiceFlag,
  addDays,
  invoiceListItemSchema,
  invoiceListResponseSchema,
  invoiceSummarySchema,
} from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  type TestApp,
  createTestApp,
  createUser,
  ingestFixture,
  ingestPdf,
  fixture,
  login,
  resetDatabase,
  resetJobs,
  setToday,
} from './helpers.js';

const TODAY = '2026-10-02';
const WEB = 'https://camex-fin.site';

type DateField = 'invoiceDate' | 'dueDate' | 'disputeDeadline' | 'paidAt';

/** Invoice columns for a seeded row; calendar dates as 'YYYY-MM-DD'. */
type Seed = Omit<
  Partial<Prisma.InvoiceUncheckedCreateInput>,
  DateField | 'inboundEmailId' | 'flags'
> &
  Partial<Record<DateField, string | null>> & {
    /** inbound_emails.received_at; rows seeded without one get increasing times. */
    receivedAt?: Date;
    /** Share one email (and so one received_at) with other rows. */
    inboundEmailId?: string;
    flags?: Pick<InvoiceFlag, 'code' | 'severity'>[];
  };

const dateColumn = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00Z`);

describe('invoices list, summary and CSV export', () => {
  let t: TestApp;
  let cookie: string;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp({ env: { WEB_ORIGINS: `${WEB},http://localhost:5180` } });
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

  async function seedEmail(receivedAt: Date): Promise<string> {
    const email = await t.prisma.inboundEmail.create({ data: { provider: 'manual', receivedAt } });
    return email.id;
  }

  /** One invoice row (needs_review, extracted) with its own email unless one is given. */
  async function seed(data: Seed = {}): Promise<string> {
    const n = ++seq;
    const {
      receivedAt,
      inboundEmailId,
      flags,
      invoiceDate,
      dueDate,
      disputeDeadline,
      paidAt,
      ...columns
    } = data;
    const emailId =
      inboundEmailId ??
      (await seedEmail(receivedAt ?? new Date(Date.UTC(2026, 8, 1, 6, 0, 0) + n * 60_000)));
    const invoice = await t.prisma.invoice.create({
      data: {
        inboundEmailId: emailId,
        fileKey: `invoices/test/${String(n)}.pdf`,
        fileName: `invoice-${String(n)}.pdf`,
        fileSha256: `sha-${String(n)}`,
        fileSize: 1000,
        status: 'needs_review',
        extractionStatus: 'succeeded',
        flags: (flags ?? []).map((flag) => ({ ...flag, field: null, message: flag.code })),
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

  async function listIds(query: string): Promise<string[]> {
    const res = await get(`/api/invoices?${query}`).expect(200);
    return invoiceListResponseSchema.parse(res.body).items.map((item) => item.id);
  }

  async function summary(query = '') {
    const res = await get(`/api/invoices/summary${query === '' ? '' : `?${query}`}`).expect(200);
    return invoiceSummarySchema.parse(res.body);
  }

  /** The export's raw bytes and text (BOM kept). */
  async function exportCsv(query = '') {
    const res = await get(`/api/invoices/export.csv${query === '' ? '' : `?${query}`}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const bytes = res.body as Buffer;
    return { res, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
  }

  describe('access and validation', () => {
    it('requires a session (401)', async () => {
      for (const path of [
        '/api/invoices',
        '/api/invoices/summary',
        '/api/invoices/export.csv',
        '/api/invoices?status=all',
      ]) {
        const res = await t.http().get(path).expect(401);
        expect(res.body.message).toBe('Not authenticated');
      }
    });

    it('refuses bad and unknown parameters (400)', async () => {
      const bad = [
        'foo=1',
        'status=processing',
        'status=open',
        'status=paid&status=unpaid',
        'sort=vendor',
        'order=up',
        'page=0',
        'page=1.5',
        'page=abc',
        'pageSize=201',
        'pageSize=0',
        'q=a',
        'q=%20a%20%20',
        'vendorId=123',
        'category=fuels',
        'currency=US',
        'currency=US1',
        'invoiceDateFrom=2026-02-30',
        'invoiceDateTo=16.09.2026',
        'invoiceDateFrom=2026-10-02&invoiceDateTo=2026-10-01',
        'hasErrors=yes',
        'due=later',
      ];
      for (const query of bad) {
        const res = await get(`/api/invoices?${query}`);
        expect(res.status, query).toBe(400);
        expect(res.body.message, query).toBe('Validation failed');
        expect(res.body.issues.length, query).toBeGreaterThan(0);
      }
    });

    it('the summary takes no status, sort or page; the export takes no page', async () => {
      for (const query of [
        'status=unpaid',
        'sort=received',
        'order=asc',
        'page=1',
        'pageSize=10',
      ]) {
        expect((await get(`/api/invoices/summary?${query}`)).status, query).toBe(400);
      }
      for (const query of ['page=1', 'pageSize=10']) {
        expect((await get(`/api/invoices/export.csv?${query}`)).status, query).toBe(400);
      }
      await get('/api/invoices/export.csv?status=unpaid&sort=amountDue&order=asc').expect(200);
    });
  });

  describe('list', () => {
    it('returns the list item shape, with defaults page 1 / 50', async () => {
      const vendor = await t.prisma.vendor.create({ data: { name: 'Petrocas' } });
      const id = await seed({
        status: 'unpaid',
        vendorId: vendor.id,
        vendorName: 'Petrocas Fuel Services Georgia LLC',
        invoiceNumber: 'PFSG-CAM-00000000510',
        invoiceDate: '2026-09-28',
        dueDate: '2026-10-09',
        dueDateSource: 'vendor_default',
        disputeDeadline: '2026-10-12',
        amountDue: '88753.98',
        amountDueCurrency: 'GEL',
        category: 'fuel',
        airportIata: 'TBS',
        locationText: 'Tbilisi International Airport',
        flags: [
          { code: 'NEW_VENDOR', severity: 'info' },
          { code: 'TOTAL_MATH', severity: 'error' },
        ],
        receivedAt: new Date('2026-09-28T07:15:00.000Z'),
      });

      const res = await get('/api/invoices?status=unpaid').expect(200);
      expect(invoiceListResponseSchema.strict().parse(res.body)).toEqual(res.body);
      expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 50 });
      const [item] = res.body.items;
      expect(invoiceListItemSchema.strict().parse(item)).toEqual(item);
      expect(item).toEqual({
        id,
        status: 'unpaid',
        extractionStatus: 'succeeded',
        receivedAt: '2026-09-28T07:15:00.000Z',
        vendor: { id: vendor.id, name: 'Petrocas' },
        vendorName: 'Petrocas Fuel Services Georgia LLC',
        invoiceNumber: 'PFSG-CAM-00000000510',
        invoiceDate: '2026-09-28',
        dueDate: '2026-10-09',
        dueDateSource: 'vendor_default',
        disputeDeadline: '2026-10-12',
        amountDue: '88753.98',
        amountDueCurrency: 'GEL',
        category: 'fuel',
        airportIata: 'TBS',
        locationText: 'Tbilisi International Airport',
        // Code and severity only: messages stay on the detail.
        flags: [
          { code: 'NEW_VENDOR', severity: 'info' },
          { code: 'TOTAL_MATH', severity: 'error' },
        ],
        paidAt: null,
        dueState: null, // due in 7 days: not soon (3 days)
      });
    });

    it('status tabs: needs_review is the default and includes processing', async () => {
      const ids = {
        processing: await seed({ status: 'processing', extractionStatus: 'pending' }),
        needs_review: await seed({ status: 'needs_review' }),
        unpaid: await seed({ status: 'unpaid' }),
        paid: await seed({ status: 'paid', paidAt: '2026-09-30' }),
        rejected: await seed({ status: 'rejected' }),
      };
      const sorted = (list: string[]) => [...list].sort();
      expect(sorted(await listIds(''))).toEqual(sorted([ids.processing, ids.needs_review]));
      expect(sorted(await listIds('status=needs_review'))).toEqual(
        sorted([ids.processing, ids.needs_review]),
      );
      expect(await listIds('status=unpaid')).toEqual([ids.unpaid]);
      expect(await listIds('status=paid')).toEqual([ids.paid]);
      expect(await listIds('status=rejected')).toEqual([ids.rejected]);
      expect(sorted(await listIds('status=all'))).toEqual(sorted(Object.values(ids)));
    });

    it('a real ingested PDF shows while processing, then with its extracted fields', async () => {
      const processing = await ingestPdf(t, { pdf: fixture('aeg.pdf'), fileName: 'aeg.pdf' });
      let res = await get('/api/invoices').expect(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({ id: processing, status: 'processing', vendorName: null }),
      ]);

      const asm = await ingestFixture(t, 'asm');
      res = await get('/api/invoices?q=CMS503').expect(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({
          id: asm,
          status: 'needs_review',
          vendorName: 'Aviation Services Management FZE',
          invoiceNumber: 'SI-000218719',
          amountDue: '15617.79',
          amountDueCurrency: 'USD',
          airportIata: 'BUD',
        }),
      ]);
    });

    describe('search', () => {
      let ids: Record<string, string>;
      beforeEach(async () => {
        const vendor = await t.prisma.vendor.create({ data: { name: 'Associated Energy Group' } });
        ids = {
          extracted: await seed({ vendorName: 'PETROCAS FUEL SERVICES' }),
          linked: await seed({ vendorId: vendor.id, vendorName: 'AEG Fuels Ireland Limited' }),
          number: await seed({ vendorName: 'Other', invoiceNumber: 'SI-000218719' }),
          registration: await seed({ vendorName: 'Other', aircraftRegistration: '4L-CME' }),
          flight: await seed({ vendorName: 'Other', flightNumbers: ['CMS503', 'CMS624'] }),
          georgian: await seed({ vendorName: 'შპს პეტროკასი ენერჯი', invoiceNumber: 'GE-1' }),
          description: await seed({ vendorName: 'Other', description: 'Catering CMS999' }),
          wildcard: await seed({ vendorName: 'abc_def 100%' }),
        };
      });

      const search = (q: string, extra = '') =>
        listIds(`status=all&q=${encodeURIComponent(q)}${extra}`);

      it('matches each field as a case-insensitive substring', async () => {
        expect(await search('petrocas fuel')).toEqual([ids.extracted]);
        expect(await search('ENERGY')).toEqual([ids.linked]); // linked vendor's name
        expect(await search('fuels ireland')).toEqual([ids.linked]); // its extracted name
        expect(await search('si-0002187')).toEqual([ids.number]);
        expect(await search('4l-c')).toEqual([ids.registration]);
        expect(await search('cms62')).toEqual([ids.flight]); // second flight number
        expect(await search('  cms503  ')).toEqual([ids.flight]); // trimmed
      });

      it('matches Georgian text, including capital (Mtavruli) letters', async () => {
        expect(await search('პეტროკას')).toEqual([ids.georgian]);
        expect(await search('ᲞᲔᲢᲠᲝᲙᲐᲡ')).toEqual([ids.georgian]);
      });

      it('does not search other fields, and treats % and _ literally', async () => {
        expect(await search('CMS999')).toEqual([]); // description only
        expect(await search('a_c')).toEqual([]); // `_` is not a wildcard (would match "abc")
        expect(await search('c_def')).toEqual([ids.wildcard]);
        expect(await search('%%')).toEqual([]);
        expect(await search('100%')).toEqual([ids.wildcard]);
      });

      it('combines with the other filters', async () => {
        await t.prisma.invoice.update({ where: { id: ids.flight }, data: { category: 'fuel' } });
        expect(await search('cms', '&category=fuel')).toEqual([ids.flight]);
        expect(await search('cms', '&category=catering')).toEqual([]);
      });
    });

    it('filters by vendor, category, currency, invoice date range and errors', async () => {
      const aeg = await t.prisma.vendor.create({ data: { name: 'AEG' } });
      const asm = await t.prisma.vendor.create({ data: { name: 'ASM' } });
      const a = await seed({
        vendorId: aeg.id,
        category: 'fuel',
        amountDueCurrency: 'USD',
        invoiceDate: '2026-09-01',
        flags: [{ code: 'TOTAL_MATH', severity: 'error' }],
      });
      const b = await seed({
        vendorId: asm.id,
        category: 'fuel',
        amountDueCurrency: 'GEL',
        invoiceDate: '2026-09-15',
        flags: [{ code: 'NEW_VENDOR', severity: 'info' }],
      });
      const c = await seed({
        vendorId: aeg.id,
        category: 'catering',
        amountDueCurrency: 'GEL',
        invoiceDate: '2026-09-30',
        flags: [
          { code: 'LINE_MATH', severity: 'warning' },
          { code: 'BANK_UNKNOWN', severity: 'error' },
        ],
      });
      const d = await seed({ invoiceDate: null }); // nothing extracted
      const all = (query: string) => listIds(`status=all&sort=received&order=asc&${query}`);

      expect(await all(`vendorId=${aeg.id}`)).toEqual([a, c]);
      expect(await all('category=fuel')).toEqual([a, b]);
      expect(await all('currency=GEL')).toEqual([b, c]);
      expect(await all('currency=gel')).toEqual([b, c]); // case-insensitive code
      expect(await all('invoiceDateFrom=2026-09-15')).toEqual([b, c]); // inclusive
      expect(await all('invoiceDateTo=2026-09-15')).toEqual([a, b]); // inclusive
      expect(await all('invoiceDateFrom=2026-09-02&invoiceDateTo=2026-09-29')).toEqual([b]);
      expect(await all('hasErrors=true')).toEqual([a, c]);
      expect(await all('hasErrors=false')).toEqual([a, b, c, d]);
      expect(await all(`vendorId=${aeg.id}&currency=GEL&hasErrors=true`)).toEqual([c]);
      expect(await all(`vendorId=${asm.id}&category=catering`)).toEqual([]);
    });

    it('dueState and due=overdue|soon use the injected business day', async () => {
      const due = (offset: number) => addDays(TODAY, offset);
      const ids = {
        overdue: await seed({ status: 'unpaid', dueDate: due(-1) }),
        today: await seed({ status: 'unpaid', dueDate: due(0) }),
        in3: await seed({ status: 'unpaid', dueDate: due(3) }),
        in4: await seed({ status: 'unpaid', dueDate: due(4) }),
        in7: await seed({ status: 'unpaid', dueDate: due(7) }),
        in8: await seed({ status: 'unpaid', dueDate: due(8) }),
        noDue: await seed({ status: 'unpaid', dueDate: null }),
        reviewPast: await seed({ status: 'needs_review', dueDate: due(-5) }),
        paidPast: await seed({ status: 'paid', dueDate: due(-5), paidAt: due(-6) }),
      };

      const res = await get('/api/invoices?status=all&pageSize=200').expect(200);
      const stateOf = Object.fromEntries(
        (res.body.items as { id: string; dueState: string | null }[]).map((i) => [
          i.id,
          i.dueState,
        ]),
      );
      expect(stateOf).toEqual({
        [ids.overdue]: 'overdue',
        [ids.today]: 'soon',
        [ids.in3]: 'soon',
        [ids.in4]: null,
        [ids.in7]: null,
        [ids.in8]: null,
        [ids.noDue]: null,
        [ids.reviewPast]: null,
        [ids.paidPast]: null,
      });

      const sorted = (list: string[]) => [...list].sort();
      expect(await listIds('status=all&due=overdue')).toEqual([ids.overdue]);
      expect(sorted(await listIds('status=unpaid&due=soon'))).toEqual(
        sorted([ids.today, ids.in3, ids.in4, ids.in7]),
      );
      expect(await listIds('status=paid&due=overdue')).toEqual([]);

      // A day later the boundaries move with the clock.
      vi.restoreAllMocks();
      setToday(t, addDays(TODAY, 1));
      expect(sorted(await listIds('status=unpaid&due=overdue'))).toEqual(
        sorted([ids.overdue, ids.today]),
      );
      expect(sorted(await listIds('status=unpaid&due=soon'))).toEqual(
        sorted([ids.in3, ids.in4, ids.in7, ids.in8]),
      );
    });

    describe('sorting', () => {
      let rows: Record<'a' | 'b' | 'c' | 'n', string>;
      beforeEach(async () => {
        rows = {
          a: await seed({
            status: 'unpaid',
            invoiceDate: '2026-09-10',
            dueDate: '2026-10-20',
            disputeDeadline: '2026-09-25',
            amountDue: '500',
            paidAt: '2026-09-30',
          }),
          b: await seed({
            status: 'unpaid',
            invoiceDate: '2026-09-05',
            dueDate: '2026-10-05',
            disputeDeadline: '2026-09-28',
            amountDue: '-20',
            paidAt: '2026-09-20',
          }),
          c: await seed({
            status: 'unpaid',
            invoiceDate: '2026-09-20',
            dueDate: '2026-10-10',
            disputeDeadline: '2026-09-22',
            amountDue: '1000.5', // after 500 numerically, before it as text
            paidAt: '2026-10-01',
          }),
          n: await seed({ status: 'unpaid' }), // every sortable value null
        };
      });

      it('sorts by every key in both orders, nulls last', async () => {
        type Key = keyof typeof rows;
        const expected: Record<string, [Key[], Key[]]> = {
          received: [
            ['a', 'b', 'c', 'n'],
            ['n', 'c', 'b', 'a'],
          ],
          invoiceDate: [
            ['b', 'a', 'c', 'n'],
            ['c', 'a', 'b', 'n'],
          ],
          dueDate: [
            ['b', 'c', 'a', 'n'],
            ['a', 'c', 'b', 'n'],
          ],
          disputeDeadline: [
            ['c', 'a', 'b', 'n'],
            ['b', 'a', 'c', 'n'],
          ],
          amountDue: [
            ['b', 'a', 'c', 'n'],
            ['c', 'a', 'b', 'n'],
          ],
          paidAt: [
            ['b', 'a', 'c', 'n'],
            ['c', 'a', 'b', 'n'],
          ],
        };
        for (const [sort, [asc, desc]] of Object.entries(expected)) {
          expect(await listIds(`status=all&sort=${sort}&order=asc`), `${sort} asc`).toEqual(
            asc.map((key) => rows[key]),
          );
          expect(await listIds(`status=all&sort=${sort}&order=desc`), `${sort} desc`).toEqual(
            desc.map((key) => rows[key]),
          );
        }
      });

      it('sort without order uses the key’s natural direction; order alone flips the default', async () => {
        const pick = (...keys: (keyof typeof rows)[]) => keys.map((key) => rows[key]);
        // amountDue defaults to largest first, dueDate to soonest first.
        expect(await listIds('status=all&sort=amountDue')).toEqual(pick('c', 'a', 'b', 'n'));
        expect(await listIds('status=unpaid&sort=dueDate')).toEqual(pick('b', 'c', 'a', 'n'));
        // Unpaid's default is dueDate asc; order=desc flips it (nulls still last).
        expect(await listIds('status=unpaid&order=desc')).toEqual(pick('a', 'c', 'b', 'n'));
      });
    });

    it('default sort per status (SPEC §10)', async () => {
      const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 6, minute));
      const review = {
        r1: await seed({ disputeDeadline: '2026-09-25', receivedAt: at(10) }),
        r2: await seed({ status: 'processing', receivedAt: at(20) }),
        r3: await seed({ disputeDeadline: '2026-09-22', receivedAt: at(30) }),
        r4: await seed({ disputeDeadline: '2026-09-25', receivedAt: at(5) }),
        r5: await seed({ receivedAt: at(15) }),
      };
      expect(await listIds('status=needs_review')).toEqual([
        review.r3, // earliest deadline
        review.r4, // same deadline as r1, received earlier
        review.r1,
        review.r5, // no deadline: last, by received
        review.r2,
      ]);

      const unpaid = {
        u1: await seed({ status: 'unpaid', dueDate: '2026-10-10' }),
        u2: await seed({ status: 'unpaid', dueDate: null }),
        u3: await seed({ status: 'unpaid', dueDate: '2026-10-05' }),
      };
      expect(await listIds('status=unpaid')).toEqual([unpaid.u3, unpaid.u1, unpaid.u2]);

      const paid = {
        p1: await seed({ status: 'paid', paidAt: '2026-09-20' }),
        p2: await seed({ status: 'paid', paidAt: '2026-10-01' }),
        p3: await seed({ status: 'paid', paidAt: null }),
      };
      expect(await listIds('status=paid')).toEqual([paid.p2, paid.p1, paid.p3]);

      const rejected = {
        x1: await seed({ status: 'rejected', receivedAt: at(1) }),
        x2: await seed({ status: 'rejected', receivedAt: at(50) }),
      };
      expect(await listIds('status=rejected')).toEqual([rejected.x2, rejected.x1]);

      const everything = await listIds('status=all&pageSize=200');
      const received = await t.prisma.invoice.findMany({
        select: { id: true, inboundEmail: { select: { receivedAt: true } } },
      });
      const expectedAll = [...received]
        .sort(
          (x, y) =>
            y.inboundEmail.receivedAt.getTime() - x.inboundEmail.receivedAt.getTime() ||
            (x.id < y.id ? 1 : -1),
        )
        .map((row) => row.id);
      expect(everything).toEqual(expectedAll);
    });

    it('pages are stable: ties break by id, no duplicates or gaps', async () => {
      // One email for all rows (identical received_at) and only three distinct due dates.
      const emailId = await seedEmail(new Date('2026-09-01T06:00:00Z'));
      const created: string[] = [];
      for (let i = 0; i < 23; i++) {
        created.push(
          await seed({
            status: 'unpaid',
            inboundEmailId: emailId,
            dueDate: ['2026-10-05', '2026-10-06', null][i % 3] ?? null,
            amountDue: '100',
          }),
        );
      }
      for (const sortQuery of [
        'sort=dueDate&order=asc',
        'sort=dueDate&order=desc',
        'sort=amountDue&order=asc',
        'sort=received&order=desc',
      ]) {
        const whole = await listIds(`status=unpaid&${sortQuery}&pageSize=200`);
        const paged: string[] = [];
        for (let page = 1; page <= 5; page++) {
          const res = await get(
            `/api/invoices?status=unpaid&${sortQuery}&pageSize=5&page=${String(page)}`,
          ).expect(200);
          expect(res.body.total).toBe(23);
          paged.push(...(res.body.items as { id: string }[]).map((item) => item.id));
        }
        expect(paged, sortQuery).toEqual(whole);
        expect(new Set(paged).size).toBe(23);
        expect([...paged].sort()).toEqual([...created].sort());
      }
      const beyond = await get('/api/invoices?status=unpaid&pageSize=5&page=6').expect(200);
      expect(beyond.body).toEqual({ items: [], total: 23, page: 6, pageSize: 5 });
    });
  });

  describe('summary', () => {
    it('counts per tab, unpaid totals per currency (exact decimals), without-amount count', async () => {
      await seed({ status: 'processing', extractionStatus: 'pending', category: 'fuel' });
      await seed({
        status: 'needs_review',
        category: 'fuel',
        amountDue: '7',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        category: 'fuel',
        amountDue: '0.1',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        category: 'fuel',
        amountDue: '0.2',
        amountDueCurrency: 'USD',
      });
      await seed({
        status: 'unpaid',
        category: 'catering',
        amountDue: '88753.98',
        amountDueCurrency: 'GEL',
      });
      await seed({
        status: 'unpaid',
        category: 'catering',
        amountDue: '0.02',
        amountDueCurrency: 'GEL',
      });
      await seed({
        status: 'unpaid',
        category: 'fuel',
        amountDue: '-12.3456',
        amountDueCurrency: 'EUR',
      });
      await seed({ status: 'unpaid', category: 'fuel', amountDue: null, amountDueCurrency: 'USD' });
      await seed({ status: 'unpaid', category: 'fuel', amountDue: '5', amountDueCurrency: null });
      await seed({ status: 'paid', category: 'fuel', amountDue: '100', amountDueCurrency: 'USD' });
      await seed({
        status: 'rejected',
        category: 'fuel',
        amountDue: '100',
        amountDueCurrency: 'USD',
      });

      const res = await get('/api/invoices/summary').expect(200);
      expect(invoiceSummarySchema.strict().parse(res.body)).toEqual(res.body);
      expect(res.body).toEqual({
        counts: { needs_review: 2, unpaid: 7, paid: 1, rejected: 1, all: 11 },
        unpaidTotals: [
          { currency: 'EUR', amount: '-12.3456' },
          { currency: 'GEL', amount: '88754' },
          { currency: 'USD', amount: '0.3' }, // not 0.30000000000000004
        ],
        unpaidWithoutAmount: 2,
        overdueCount: 0,
        dueNext7Count: 0,
      });

      expect(await summary('category=fuel')).toEqual({
        counts: { needs_review: 2, unpaid: 5, paid: 1, rejected: 1, all: 9 },
        unpaidTotals: [
          { currency: 'EUR', amount: '-12.3456' },
          { currency: 'USD', amount: '0.3' },
        ],
        unpaidWithoutAmount: 2,
        overdueCount: 0,
        dueNext7Count: 0,
      });

      expect(await summary('currency=GEL')).toMatchObject({
        counts: { needs_review: 0, unpaid: 2, paid: 0, rejected: 0, all: 2 },
        unpaidTotals: [{ currency: 'GEL', amount: '88754' }],
        unpaidWithoutAmount: 0,
      });
    });

    it('overdue and next-7-days counts (unpaid only) follow the clock and the filters', async () => {
      const due = (offset: number) => addDays(TODAY, offset);
      await seed({ status: 'unpaid', dueDate: due(-30), category: 'fuel' });
      await seed({ status: 'unpaid', dueDate: due(-1), category: 'catering' });
      await seed({ status: 'unpaid', dueDate: due(0), category: 'fuel' });
      await seed({ status: 'unpaid', dueDate: due(7), category: 'fuel' });
      await seed({ status: 'unpaid', dueDate: due(8), category: 'fuel' });
      await seed({ status: 'unpaid', dueDate: null, category: 'fuel' });
      await seed({ status: 'needs_review', dueDate: due(-1), category: 'fuel' });
      await seed({ status: 'paid', dueDate: due(1), paidAt: due(0), category: 'fuel' });

      expect(await summary()).toMatchObject({ overdueCount: 2, dueNext7Count: 2 });
      expect(await summary('category=fuel')).toMatchObject({ overdueCount: 1, dueNext7Count: 2 });
      // The `due` filter applies to the summary like any other filter.
      expect(await summary('due=overdue')).toMatchObject({
        counts: { needs_review: 0, unpaid: 2, paid: 0, rejected: 0, all: 2 },
        overdueCount: 2,
        dueNext7Count: 0,
      });

      vi.restoreAllMocks();
      setToday(t, due(1));
      expect(await summary()).toMatchObject({ overdueCount: 3, dueNext7Count: 2 });
    });

    it('search and the other filters narrow the counts', async () => {
      const vendor = await t.prisma.vendor.create({ data: { name: 'ASM' } });
      await seed({
        status: 'unpaid',
        vendorId: vendor.id,
        amountDue: '10',
        amountDueCurrency: 'USD',
      });
      await seed({ status: 'paid', vendorId: vendor.id, flightNumbers: ['CMS503'] });
      await seed({
        status: 'needs_review',
        vendorName: 'Petrocas',
        flags: [{ code: 'TOTAL_MATH', severity: 'error' }],
      });

      expect((await summary(`vendorId=${vendor.id}`)).counts).toEqual({
        needs_review: 0,
        unpaid: 1,
        paid: 1,
        rejected: 0,
        all: 2,
      });
      expect((await summary('q=cms503')).counts.all).toBe(1);
      expect((await summary('q=petro')).counts.needs_review).toBe(1);
      expect((await summary('hasErrors=true')).counts).toMatchObject({ needs_review: 1, all: 1 });
      expect((await summary('invoiceDateFrom=2026-01-01')).counts.all).toBe(0);
    });
  });

  describe('CSV export', () => {
    /** RFC 4180 parser for checking round trips (quoted fields, "" escapes, CRLF records). */
    function parseCsv(text: string): string[][] {
      const rows: string[][] = [];
      let row: string[] = [];
      let field = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charAt(i);
        if (quoted) {
          if (c === '"' && text[i + 1] === '"') {
            field += '"';
            i++;
          } else if (c === '"') {
            quoted = false;
          } else {
            field += c;
          }
        } else if (c === '"') {
          quoted = true;
        } else if (c === ',') {
          row.push(field);
          field = '';
        } else if (c === '\r' && text[i + 1] === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
          i++;
        } else {
          field += c;
        }
      }
      if (field !== '' || row.length > 0) throw new Error('last record is not CRLF-terminated');
      return rows;
    }

    const HEADER =
      'id,status,received_at,vendor,invoice_number,invoice_date,due_date,dispute_deadline,amount_due,amount_due_currency,total_amount,currency,category,description,airport,aircraft_registration,flight_numbers,flags,approved_at,paid_at,payment_reference,url';

    it('UTF-8 with BOM, CRLF, header, attachment filename per status and day', async () => {
      const { res, bytes, text } = await exportCsv();
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="invoices-needs_review-${TODAY}.csv"`,
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(text).toBe(`\uFEFF${HEADER}\r\n`);

      const unpaid = await exportCsv('status=unpaid');
      expect(unpaid.res.headers['content-disposition']).toBe(
        `attachment; filename="invoices-unpaid-${TODAY}.csv"`,
      );
    });

    it('writes every column: decimals as stored, dates, UTC timestamps, lists, the web URL', async () => {
      const vendor = await t.prisma.vendor.create({
        data: { name: 'Aviation Services Management' },
      });
      const id = await seed({
        status: 'paid',
        vendorId: vendor.id,
        vendorName: 'Aviation Services Management FZE',
        invoiceNumber: 'SI-000218719',
        invoiceDate: '2026-09-16',
        dueDate: '2026-09-16',
        disputeDeadline: '2026-09-30',
        amountDue: '12345678901234.5678',
        amountDueCurrency: 'USD',
        totalAmount: '15617.7900',
        currency: 'USD',
        category: 'fuel',
        description: 'Jet A-1 uplift, BUD, CMS503/4',
        airportIata: 'BUD',
        locationText: 'LHBP/BUD Ferihegy',
        aircraftRegistration: '4L-CME',
        flightNumbers: ['CMS503', 'CMS504'],
        flags: [
          { code: 'DUE_DATE_DERIVED', severity: 'info' },
          { code: 'NEW_VENDOR', severity: 'info' },
        ],
        approvedAt: new Date('2026-09-17T10:30:00.123+04:00'),
        paidAt: '2026-09-20',
        paymentReference: 'TRX 991',
        receivedAt: new Date('2026-09-16T09:00:00Z'),
      });
      const noAirport = await seed({
        status: 'paid',
        locationText: 'Bucharest',
        paidAt: '2026-09-21',
      });

      const { text } = await exportCsv('status=paid&sort=paidAt&order=asc');
      const [header, first, second, ...rest] = parseCsv(text.slice(1));
      expect(header?.join(',')).toBe(HEADER);
      expect(rest).toEqual([]);
      expect(first).toEqual([
        id,
        'paid',
        '2026-09-16T09:00:00.000Z',
        'Aviation Services Management', // the linked vendor's name
        'SI-000218719',
        '2026-09-16',
        '2026-09-16',
        '2026-09-30',
        '12345678901234.5678',
        'USD',
        '15617.79',
        'USD',
        'fuel',
        'Jet A-1 uplift, BUD, CMS503/4',
        'BUD',
        '4L-CME',
        'CMS503 CMS504',
        'DUE_DATE_DERIVED NEW_VENDOR',
        '2026-09-17T06:30:00.123Z',
        '2026-09-20',
        'TRX 991',
        `${WEB}/invoices/${id}`,
      ]);
      expect(second?.[0]).toBe(noAirport);
      expect(second?.[3]).toBe(''); // no vendor at all
      expect(second?.[14]).toBe('Bucharest'); // airport: location text without IATA
      // The description has a comma, so it is quoted in the file.
      expect(text).toContain(',"Jet A-1 uplift, BUD, CMS503/4",');
    });

    it('quotes commas, quotes and newlines (RFC 4180); Georgian text round-trips', async () => {
      const tricky = 'ACME "Fuel", Ltd\r\nSecond line\nThird';
      const georgian = 'შპს პეტროკასი ენერჯი — ინვოისი №5';
      await seed({
        vendorName: tricky,
        invoiceNumber: 'A-1',
        receivedAt: new Date('2026-09-01T00:00:00Z'),
      });
      await seed({
        vendorName: georgian,
        invoiceNumber: 'A-2',
        receivedAt: new Date('2026-09-02T00:00:00Z'),
      });

      const { text, bytes } = await exportCsv('status=all&sort=received&order=asc');
      expect(text).toContain('"ACME ""Fuel"", Ltd\r\nSecond line\nThird"');
      const rows = parseCsv(text.slice(1));
      expect(rows.map((row) => row[3])).toEqual(['vendor', tricky, georgian]);
      expect(rows.every((row) => row.length === 22)).toBe(true);
      // The UTF-8 bytes of the Georgian name are in the file as is.
      expect(bytes.includes(Buffer.from(georgian, 'utf8'))).toBe(true);
    });

    it("prefixes formula-like text with ' but leaves negative amounts numeric", async () => {
      await seed({
        status: 'unpaid',
        vendorName: '=HYPERLINK("https://evil.example","Click")',
        invoiceNumber: '+12345',
        description: '-2+3',
        aircraftRegistration: '@SUM(A1)',
        paymentReference: '\tTAB',
        locationText: '\rCR',
        amountDue: '-120.5',
        amountDueCurrency: 'USD',
        totalAmount: '-0.0001',
        currency: 'USD',
      });
      const { text } = await exportCsv('status=unpaid');
      const [, row] = parseCsv(text.slice(1));
      const column = (name: string) => row?.[HEADER.split(',').indexOf(name)];
      expect(column('vendor')).toBe('\'=HYPERLINK("https://evil.example","Click")');
      expect(column('invoice_number')).toBe("'+12345");
      expect(column('description')).toBe("'-2+3");
      expect(column('aircraft_registration')).toBe("'@SUM(A1)");
      expect(column('payment_reference')).toBe("'\tTAB");
      expect(column('airport')).toBe("'\rCR");
      expect(column('amount_due')).toBe('-120.5');
      expect(column('total_amount')).toBe('-0.0001');
    });

    it('uses the same filters and sort as the list', async () => {
      for (let i = 0; i < 6; i++) {
        await seed({
          status: i % 2 === 0 ? 'unpaid' : 'paid',
          amountDue: String(100 - i * 7),
          amountDueCurrency: i < 3 ? 'USD' : 'GEL',
          paidAt: i % 2 === 0 ? null : `2026-09-1${String(i)}`,
        });
      }
      for (const query of [
        'status=unpaid',
        'status=all&sort=amountDue&order=asc',
        'status=all&currency=GEL',
        'status=paid',
      ]) {
        const { text } = await exportCsv(query);
        const csvIds = parseCsv(text.slice(1))
          .slice(1)
          .map((row) => row[0]);
        expect(csvIds, query).toEqual(await listIds(`${query}&pageSize=200`));
      }
    });

    it('exports up to 10,000 rows and refuses more (400)', async () => {
      const emailId = await seedEmail(new Date('2026-09-01T06:00:00Z'));
      const insert = (count: number, from: number) => t.prisma.$executeRaw`
        INSERT INTO invoices (inbound_email_id, file_key, file_name, file_sha256, file_size, status,
          extraction_status, amount_due, amount_due_currency, updated_at)
        SELECT ${emailId}::uuid, 'invoices/bulk/' || n, n || '.pdf', 'sha-bulk-' || n, 1, 'unpaid',
          'succeeded', 1.5, 'USD', now()
        FROM generate_series(${from}::int, ${from + count - 1}::int) AS n`;
      await insert(10_000, 1);

      const ok = await exportCsv('status=unpaid');
      expect(ok.res.status).toBe(200);
      expect(parseCsv(ok.text.slice(1))).toHaveLength(10_001);

      await insert(1, 10_001);
      const tooMany = await get('/api/invoices/export.csv?status=unpaid').expect(400);
      expect(tooMany.body.message).toBe(
        'More than 10,000 invoices match. Narrow the filter to export them.',
      );
      // A narrower filter exports again.
      await get('/api/invoices/export.csv?status=needs_review').expect(200);
      // The summary sums the same rows exactly: 10,001 × 1.5.
      expect((await summary()).unpaidTotals).toEqual([{ currency: 'USD', amount: '15001.5' }]);
    });
  });
});
