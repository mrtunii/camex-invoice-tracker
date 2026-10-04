import {
  type InvoiceStatus,
  STALE_MESSAGE,
  invoiceDetailSchema,
  invoiceEventsResponseSchema,
  workflowConflictSchema,
} from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRACT_QUEUE } from '../src/extraction/extraction-queue.js';
import type { User } from '../src/generated/prisma/client.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  type TestApp,
  asmWireOutput,
  createTestApp,
  createUser,
  expectedExtraction,
  extractWith,
  flagCodes,
  ingestFixture,
  ingestPdf,
  login,
  pdfVariant,
  resetDatabase,
  resetJobs,
  setToday,
  wireFromExpected,
} from './helpers.js';

// T06: the SPEC §6 state machine, edits and the activity log (clock at 2026-10-02 in Tbilisi).

type Action = 'approve' | 'reject' | 'reextract' | 'mark-paid' | 'undo-payment' | 'reopen';

describe('invoice workflow', () => {
  let t: TestApp;
  let cookie: string;
  let user: User;

  beforeAll(async () => {
    t = await createTestApp(); // workers off: tests run the extraction handler themselves
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    user = await createUser(t.prisma, { email: 'clerk@camex.aero', name: 'Nino Clerk' });
    cookie = await login(t, 'clerk@camex.aero');
    setToday(t, '2026-10-02');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = (id: string) => t.prisma.invoice.findUniqueOrThrow({ where: { id } });
  const versionOf = async (id: string) => (await row(id)).version;
  const codesOf = async (id: string) => flagCodes((await row(id)).flags);

  /**
   * POST /api/invoices/:id/<action> with the current version (unless the body sets one); with
   * `status`, asserts it. (A helper can't hand back the supertest request itself: awaiting the
   * helper would already send it.)
   */
  const act = async (id: string, action: Action, body: object = {}, status?: number) => {
    const req = t
      .http()
      .post(`/api/invoices/${id}/${action}`)
      .set('Cookie', cookie)
      .send({ version: await versionOf(id), ...body });
    return status === undefined ? req : req.expect(status);
  };
  const edit = async (id: string, body: object, status?: number) => {
    const req = t
      .http()
      .patch(`/api/invoices/${id}`)
      .set('Cookie', cookie)
      .send({ version: await versionOf(id), ...body });
    return status === undefined ? req : req.expect(status);
  };
  const get = (path: string) => t.http().get(path).set('Cookie', cookie);
  const createVendor = async (body: object) =>
    (await t.http().post('/api/vendors').set('Cookie', cookie).send(body).expect(201)).body
      .id as string;
  const conflict = (body: unknown) => workflowConflictSchema.parse(body);
  const events = async (id: string) =>
    invoiceEventsResponseSchema.parse((await get(`/api/invoices/${id}/events`).expect(200)).body)
      .events;

  /** ASM linked to its vendor by name: every required field, no error flag. */
  async function readyAsm(options: Parameters<typeof ingestFixture>[2] = {}) {
    const vendorId = await createVendor({ name: 'Aviation Services Management' });
    const id = await ingestFixture(t, 'asm', options);
    expect((await row(id)).vendorId).toBe(vendorId);
    return { id, vendorId };
  }

  describe('transitions', () => {
    const ALLOWED: Record<Action | 'edit', readonly InvoiceStatus[]> = {
      edit: ['needs_review'],
      approve: ['needs_review'],
      reject: ['needs_review'],
      reextract: ['needs_review'],
      'mark-paid': ['unpaid'],
      'undo-payment': ['paid'],
      reopen: ['unpaid', 'rejected'],
    };
    const TO: Record<Action | 'edit', InvoiceStatus> = {
      edit: 'needs_review',
      approve: 'unpaid',
      reject: 'rejected',
      reextract: 'processing',
      'mark-paid': 'paid',
      'undo-payment': 'unpaid',
      reopen: 'needs_review',
    };
    const BODY: Record<Action, object> = {
      approve: { confirmErrors: true },
      reject: { reason: 'duplicate' },
      reextract: {},
      'mark-paid': { paidAt: '2026-10-01' },
      'undo-payment': {},
      reopen: {},
    };
    const STATUSES: InvoiceStatus[] = ['processing', 'needs_review', 'unpaid', 'paid', 'rejected'];

    it('every action from every status: allowed ones move it and bump the version, the rest are 409 INVALID_TRANSITION', async () => {
      const { id } = await readyAsm();
      let n = 0;
      for (const action of Object.keys(ALLOWED) as (Action | 'edit')[]) {
        for (const from of STATUSES) {
          await t.prisma.invoice.update({ where: { id }, data: { status: from } });
          const before = await versionOf(id);
          const res =
            action === 'edit'
              ? await edit(id, { notes: `Note ${String(++n)}` })
              : await act(id, action, BODY[action]);
          const label = `${action} from ${from}`;
          if (ALLOWED[action].includes(from)) {
            expect(res.status, label).toBe(200);
            expect(res.body.status, label).toBe(TO[action]);
            expect(res.body.version, label).toBe(before + 1);
          } else {
            expect(res.status, label).toBe(409);
            expect(conflict(res.body), label).toMatchObject({
              code: 'INVALID_TRANSITION',
              status: from,
            });
            expect(res.body.message, label).toMatch(/^This invoice .+, so it can't .+\.$/);
            expect(await versionOf(id), label).toBe(before);
            expect((await row(id)).status, label).toBe(from);
          }
        }
      }
    });

    it('409 STALE on a wrong version, before the status is looked at; nothing is written', async () => {
      const { id } = await readyAsm();
      const eventsBefore = await t.prisma.invoiceEvent.count({ where: { invoiceId: id } });
      const stale = async (path: string, body: object, method: 'post' | 'patch' = 'post') => {
        const res = await t
          .http()
          [method](`/api/invoices/${id}${path}`)
          .set('Cookie', cookie)
          .send({ version: 7, ...body })
          .expect(409);
        expect(conflict(res.body)).toEqual({
          statusCode: 409,
          code: 'STALE',
          message: STALE_MESSAGE,
        });
      };
      await stale('', { notes: 'x' }, 'patch');
      await stale('/approve', {});
      await stale('/reject', { reason: 'disputed' });
      await stale('/reextract', {});
      await stale('/mark-paid', { paidAt: '2026-10-01' }); // wrong status too: STALE wins
      await stale('/undo-payment', {});
      await stale('/reopen', {});
      await stale('/vendor', { vendorId: '00000000-0000-0000-0000-000000000000' });
      await stale('/trust-bank-details', {});

      const after = await row(id);
      expect(after).toMatchObject({
        status: 'needs_review',
        version: 0,
        notes: expect.any(String),
      });
      expect(await t.prisma.invoiceEvent.count({ where: { invoiceId: id } })).toBe(eventsBefore);
    });

    it('400 without a version; 404 for an unknown invoice', async () => {
      const { id } = await readyAsm();
      await t.http().post(`/api/invoices/${id}/approve`).set('Cookie', cookie).send({}).expect(400);
      await t.http().patch(`/api/invoices/${id}`).set('Cookie', cookie).send({}).expect(400);
      await t
        .http()
        .post('/api/invoices/00000000-0000-0000-0000-000000000000/reopen')
        .set('Cookie', cookie)
        .send({ version: 0 })
        .expect(404);
    });
  });

  describe('approve', () => {
    it('sets approved_at/by and writes `approved`', async () => {
      const { id } = await readyAsm();
      const res = await act(id, 'approve', {}, 200);
      const detail = invoiceDetailSchema.parse(res.body);
      expect(detail).toMatchObject({
        status: 'unpaid',
        version: 1,
        approvedBy: { id: user.id, name: 'Nino Clerk' },
        approvedAt: expect.stringMatching(/^\d{4}-/),
      });
      // DISPUTE_SOON is for invoices to review only.
      expect(flagCodes(detail.flags)).toEqual(['BANK_FIRST_SEEN']);
      const [approved] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'approved' },
      });
      expect(approved).toMatchObject({ userId: user.id, data: { overriddenFlags: [] } });
    });

    it('409 MISSING_REQUIRED with the fields, even with confirmErrors', async () => {
      await createVendor({ name: 'Petrocas Fuel Services Georgia' });
      const id = await ingestFixture(t, 'petrocas'); // no due date
      const res = await act(id, 'approve', { confirmErrors: true }, 409);
      expect(conflict(res.body)).toMatchObject({
        code: 'MISSING_REQUIRED',
        fields: [{ field: 'dueDate', message: 'Due date is missing' }],
      });
      expect(await row(id)).toMatchObject({ status: 'needs_review', version: 0 });
    });

    it('409 VENDOR_REQUIRED without a linked vendor', async () => {
      const id = await ingestFixture(t, 'asm');
      const res = await act(id, 'approve', { confirmErrors: true }, 409);
      expect(conflict(res.body).code).toBe('VENDOR_REQUIRED');
    });

    it('409 CONFIRM_REQUIRED with the error flags; confirmErrors records the overridden codes', async () => {
      const { id } = await readyAsm({ wire: { totalAmount: '15000.00' } });
      expect(await codesOf(id)).toContain('TOTAL_MATH');

      const res = await act(id, 'approve', {}, 409);
      expect(conflict(res.body)).toMatchObject({
        code: 'CONFIRM_REQUIRED',
        flags: [{ code: 'TOTAL_MATH', message: expect.stringContaining('not the total') }],
      });
      expect((await row(id)).status).toBe('needs_review');

      await act(id, 'approve', { confirmErrors: true }, 200);
      const [approved] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'approved' },
      });
      expect(approved?.data).toEqual({ overriddenFlags: ['TOTAL_MATH'] });
    });

    it('trustBankDetails adds the account in the same transaction, with its own event', async () => {
      const { id, vendorId } = await readyAsm();
      expect(await codesOf(id)).toContain('BANK_FIRST_SEEN');

      const res = await act(id, 'approve', { trustBankDetails: true }, 200);
      expect(flagCodes(res.body.flags)).toEqual([]);
      const vendor = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(vendor.bankAccounts).toEqual([
        expect.objectContaining({
          iban: 'AE300440000101236468501',
          source_invoice_id: id,
          added_by_id: user.id,
          removed_at: null,
        }),
      ]);
      // Trusted first, then approved (clock_timestamp keeps the order inside one transaction).
      expect((await events(id)).slice(0, 2).map((e) => e.type)).toEqual([
        'approved',
        'bank_account_trusted',
      ]);
    });

    it('a failed approve trusts nothing (one transaction)', async () => {
      const { id, vendorId } = await readyAsm({ wire: { totalAmount: '1.00' } });
      await act(id, 'approve', { trustBankDetails: true }, 409); // CONFIRM_REQUIRED
      const noBank = await ingestFixture(t, 'asm', {
        pdf: pdfVariant('asm', 'nobank'),
        wire: {
          invoiceNumber: 'SI-1',
          bankDetails: { ...asmWireOutput().bankDetails, iban: '', accountNumber: '' },
        },
      });
      const res = await act(
        noBank,
        'approve',
        { trustBankDetails: true, confirmErrors: true },
        409,
      );
      expect(res.body.message).toBe('The invoice has no IBAN or account number to trust');

      const vendor = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(vendor.bankAccounts).toEqual([]);
      expect(await t.prisma.invoiceEvent.count({ where: { type: 'bank_account_trusted' } })).toBe(
        0,
      );
      expect((await row(noBank)).status).toBe('needs_review');
    });

    it('BANK_UNKNOWN needs confirmErrors even with trustBankDetails', async () => {
      const vendorId = await createVendor({ name: 'AEG Fuels Ireland' });
      const first = await ingestFixture(t, 'aeg');
      await act(first, 'approve', { trustBankDetails: true }, 200);
      const other = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', 'other'),
        wire: {
          invoiceNumber: '3110999',
          bankDetails: {
            ...wireFromExpected(expectedExtraction('aeg')).bankDetails,
            accountNumber: '9999 999 999',
          },
        },
      });
      expect(await codesOf(other)).toContain('BANK_UNKNOWN');

      const blocked = await act(other, 'approve', { trustBankDetails: true }, 409);
      expect(conflict(blocked.body)).toMatchObject({
        code: 'CONFIRM_REQUIRED',
        flags: [
          {
            code: 'BANK_UNKNOWN',
            message:
              'Bank details differ from the ones on file: verify by phone with the vendor before paying',
          },
        ],
      });
      let vendor = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(vendor.bankAccounts).toHaveLength(1);

      await act(other, 'approve', { trustBankDetails: true, confirmErrors: true }, 200);
      vendor = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(vendor.bankAccounts).toHaveLength(2);
      const [approved] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: other, type: 'approved' },
      });
      expect(approved?.data).toEqual({ overriddenFlags: ['BANK_UNKNOWN'] });
    });
  });

  describe('mark paid, undo payment, reject, reopen', () => {
    it('mark paid: today in Tbilisi at the latest (400 after); sets and clears the payment fields', async () => {
      const { id } = await readyAsm();
      await act(id, 'approve', {}, 200);

      const future = await act(id, 'mark-paid', { paidAt: '2026-10-03' }, 400);
      expect(future.body.issues).toEqual([
        { path: 'paidAt', message: "The payment date can't be after today" },
      ]);
      await act(id, 'mark-paid', { paidAt: '2026-02-30' }, 400);

      const paid = await act(
        id,
        'mark-paid',
        {
          paidAt: '2026-10-02',
          paymentReference: ' TRX-2291 ',
          paymentNote: '',
        },
        200,
      );
      expect(paid.body).toMatchObject({
        status: 'paid',
        paidAt: '2026-10-02',
        paidBy: { id: user.id, name: 'Nino Clerk' },
        paymentReference: 'TRX-2291',
        paymentNote: null,
      });
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'paid' },
      });
      expect(event?.data).toEqual({
        paidAt: '2026-10-02',
        reference: 'TRX-2291',
        overriddenFlags: [],
      });

      const undone = await act(id, 'undo-payment', {}, 200);
      expect(undone.body).toMatchObject({
        status: 'unpaid',
        paidAt: null,
        paidBy: null,
        paymentReference: null,
        paymentNote: null,
        approvedBy: { id: user.id },
      });
      const [undo] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'payment_undone' },
      });
      expect(undo).toMatchObject({ userId: user.id, data: { previousPaidAt: '2026-10-02' } });
    });

    it('mark paid re-evaluates first: an error flag (BANK_UNKNOWN) needs confirmErrors', async () => {
      const { id, vendorId } = await readyAsm();
      await act(id, 'approve', { trustBankDetails: true }, 200);
      // The trusted account is replaced behind the invoice's back (no re-evaluation yet).
      const [account] = (await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
        .bankAccounts as { iban: string }[];
      await t.prisma.vendor.update({
        where: { id: vendorId },
        data: { bankAccounts: [{ ...account, iban: 'AE000000000000000000001' }] },
      });
      expect(await codesOf(id)).not.toContain('BANK_UNKNOWN');

      const blocked = await act(id, 'mark-paid', { paidAt: '2026-10-02' }, 409);
      expect(conflict(blocked.body)).toMatchObject({
        code: 'CONFIRM_REQUIRED',
        flags: [{ code: 'BANK_UNKNOWN' }],
      });
      expect((await row(id)).status).toBe('unpaid');

      await act(id, 'mark-paid', { paidAt: '2026-10-02', confirmErrors: true }, 200);
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'paid' },
      });
      expect(event?.data).toMatchObject({ overriddenFlags: ['BANK_UNKNOWN'] });
    });

    it('reject: a note is required for "other"; rejecting a duplicate clears the flag on the other copy; reopen brings it back', async () => {
      const first = await ingestFixture(t, 'asm');
      const copy = await ingestFixture(t, 'asm'); // same PDF, same number
      expect(await codesOf(first)).toEqual(
        expect.arrayContaining(['DUPLICATE_FILE', 'DUPLICATE_NUMBER']),
      );

      const noNote = await act(copy, 'reject', { reason: 'other', note: '  ' }, 400);
      expect(noNote.body.issues).toEqual([{ path: 'note', message: 'Say why it is rejected' }]);
      await act(copy, 'reject', { reason: 'maybe' }, 400);

      const rejected = await act(copy, 'reject', { reason: 'duplicate', note: 'Sent twice' }, 200);
      expect(rejected.body).toMatchObject({
        status: 'rejected',
        rejectionReason: 'duplicate',
        rejectionNote: 'Sent twice',
        rejectedBy: { id: user.id, name: 'Nino Clerk' },
        rejectedAt: expect.any(String),
      });
      const codes = await codesOf(first);
      expect(codes).not.toContain('DUPLICATE_FILE');
      expect(codes).not.toContain('DUPLICATE_NUMBER');
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: copy, type: 'rejected' },
      });
      expect(event?.data).toEqual({ reason: 'duplicate', note: 'Sent twice' });

      const reopened = await act(copy, 'reopen', {}, 200);
      expect(reopened.body).toMatchObject({
        status: 'needs_review',
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        rejectionNote: null,
      });
      expect(await codesOf(first)).toEqual(
        expect.arrayContaining(['DUPLICATE_FILE', 'DUPLICATE_NUMBER']),
      );
      const [reopenEvent] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: copy, type: 'reopened' },
      });
      expect(reopenEvent).toMatchObject({ userId: user.id, data: { from: 'rejected' } });
    });

    it('reopen from To pay clears the approval; DISPUTE_SOON comes back', async () => {
      const { id } = await readyAsm();
      await act(id, 'approve', {}, 200);
      const res = await act(id, 'reopen', {}, 200);
      expect(res.body).toMatchObject({
        status: 'needs_review',
        approvedAt: null,
        approvedBy: null,
      });
      expect(flagCodes(res.body.flags)).toContain('DISPUTE_SOON');
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'reopened' },
      });
      expect(event?.data).toEqual({ from: 'unpaid' });
    });
  });

  describe('PATCH /api/invoices/:id', () => {
    it('normalizes like the extraction', async () => {
      const id = await ingestFixture(t, 'aeg');
      const res = await edit(
        id,
        {
          aircraftRegistration: ' 4lcmy ',
          flightNumbers: ['cms624/5', 'CMS624'],
          airportIcao: 'lrop',
          airportIata: 'otp',
          currency: 'usd',
          amountDue: '6,416.29',
          invoiceNumber: '  3110713-A ',
          vendorName: '  AEG   Fuels  ',
          paymentTermsDays: 10,
          bankDetails: {
            beneficiary: 'Associated  Energy Group LLC',
            bankName: null,
            iban: 'ro49 aaaa-1b31 0075 9384 0000',
            accountNumber: 'RO49AAAA1B31007593840000',
            swift: 'wfbi us 6s',
            routingNumber: '',
            currency: 'usd',
          },
          lineItems: [
            {
              kind: 'item',
              description: ' Jet A-1 ',
              quantity: '1,334.590',
              uom: 'USG',
              unitPrice: '4.8413',
              amount: '6461.29',
            },
          ],
        },
        200,
      );
      expect(res.body).toMatchObject({
        aircraftRegistration: '4L-CMY',
        flightNumbers: ['CMS624', 'CMS625'],
        airportIcao: 'LROP',
        airportIata: 'OTP',
        currency: 'USD',
        amountDue: '6416.29',
        invoiceNumber: '3110713-A',
        vendorName: 'AEG Fuels',
        paymentTermsDays: 10,
        bankDetails: {
          beneficiary: 'Associated Energy Group LLC',
          bankName: null,
          iban: 'RO49AAAA1B31007593840000',
          accountNumber: null, // just the IBAN again
          swift: 'WFBIUS6S',
          routingNumber: null,
          currency: 'USD',
        },
        lineItems: [
          {
            kind: 'item',
            description: 'Jet A-1',
            quantity: '1334.590',
            uom: 'USG',
            unitPrice: '4.8413',
            amount: '6461.29',
          },
        ],
      });
    });

    it('400 with a message per field for values the rules refuse', async () => {
      const id = await ingestFixture(t, 'aeg');
      const res = await edit(
        id,
        {
          airportIcao: 'XX',
          invoiceDate: '2026-02-30',
          amountDue: '1.23456',
          taxAmount: '12,34',
          currency: 'us',
          paymentTermsDays: 1000,
          lineItems: [
            {
              kind: 'item',
              description: null,
              quantity: null,
              uom: null,
              unitPrice: '1.1234567',
              amount: null,
            },
          ],
        },
        400,
      );
      expect(res.body.issues).toEqual(
        expect.arrayContaining([
          { path: 'airportIcao', message: 'Use a 4-letter ICAO code like UGTB' },
          { path: 'invoiceDate', message: 'Enter a real date' },
          { path: 'amountDue', message: 'Use at most 4 decimals' },
          { path: 'taxAmount', message: 'Enter a number like 1234.56' },
          { path: 'currency', message: 'Use a 3-letter code like USD' },
          { path: 'paymentTermsDays', message: 'Use 0 to 999 days' },
          { path: 'lineItems.0.unitPrice', message: 'Use at most 6 decimals' },
        ]),
      );
      expect(await versionOf(id)).toBe(0);
      await edit(id, { status: 'paid' }, 400); // not an editable field
    });

    it('writes and records only the fields that change', async () => {
      const id = await ingestFixture(t, 'aeg');
      const current = expectedExtraction('aeg');
      const res = await edit(
        id,
        {
          invoiceNumber: current.invoiceNumber,
          notes: current.notes,
          amountDue: '6461.290', // the same amount
          lineItems: current.lineItems,
          totalAmount: '6416.29',
        },
        200,
      );
      expect(res.body.version).toBe(1);
      const edited = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'edited' },
      });
      expect(edited).toMatchObject([
        { userId: user.id, data: { totalAmount: { from: '6461.29', to: '6416.29' } } },
      ]);

      // Nothing new: no event, same version.
      const same = await edit(id, { totalAmount: '6416.29' }, 200);
      expect(same.body.version).toBe(1);
      expect(await t.prisma.invoiceEvent.count({ where: { type: 'edited' } })).toBe(1);
    });

    it('records bank details and line items with their values', async () => {
      const id = await ingestFixture(t, 'asm');
      const bank = expectedExtraction('asm').bankDetails;
      await edit(id, { bankDetails: { ...bank, iban: 'AE07 0331 2345 6789 0123 456' } }, 200);
      const [event] = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'edited' },
      });
      expect(event?.data).toEqual({
        bankDetails: { from: bank, to: { ...bank, iban: 'AE070331234567890123456' } },
      });
    });

    it('a due date set by hand is `manual`; clearing it lets it be derived again', async () => {
      await createVendor({ name: 'Petrocas Fuel Services Georgia', defaultPaymentTermsDays: 10 });
      const id = await ingestFixture(t, 'petrocas');
      expect(await row(id)).toMatchObject({ dueDateSource: 'vendor_default' });

      let res = await edit(id, { dueDate: '2026-10-20' }, 200);
      expect(res.body).toMatchObject({ dueDate: '2026-10-20', dueDateSource: 'manual' });
      expect(flagCodes(res.body.flags)).not.toContain('DUE_DATE_DERIVED');

      // Not re-derived when the terms change.
      res = await edit(id, { paymentTermsDays: 30 }, 200);
      expect(res.body).toMatchObject({ dueDate: '2026-10-20', dueDateSource: 'manual' });

      res = await edit(id, { dueDate: null }, 200);
      expect(res.body).toMatchObject({ dueDate: '2026-11-01', dueDateSource: 'terms' });
      const edits = await t.prisma.invoiceEvent.findMany({
        where: { invoiceId: id, type: 'edited' },
        orderBy: { createdAt: 'asc' },
      });
      expect(edits.map((e) => e.data)).toEqual([
        { dueDate: { from: '2026-10-12', to: '2026-10-20' } },
        { paymentTermsDays: { from: null, to: 30 } },
        { dueDate: { from: '2026-10-20', to: null } },
      ]);
    });

    it('a new invoice number re-evaluates the invoices that shared the old one', async () => {
      const first = await ingestFixture(t, 'asm');
      const second = await ingestFixture(t, 'asm', { pdf: pdfVariant('asm', '2') });
      expect(await codesOf(first)).toContain('DUPLICATE_NUMBER');
      expect(await codesOf(second)).toContain('DUPLICATE_NUMBER');

      const res = await edit(second, { invoiceNumber: 'SI-000218720' }, 200);
      expect(flagCodes(res.body.flags)).not.toContain('DUPLICATE_NUMBER');
      expect(await codesOf(first)).not.toContain('DUPLICATE_NUMBER');
    });
  });

  describe('re-extract', () => {
    it('overwrites edited fields and the due date source, keeps the vendor link, bumps the version', async () => {
      const id = await ingestFixture(t, 'asm');
      await t
        .http()
        .post(`/api/invoices/${id}/vendor`)
        .set('Cookie', cookie)
        .send({ version: 0, create: { name: 'ASM Dubai' } })
        .expect(200);
      await edit(id, { amountDue: '1.00', notes: 'Edited', dueDate: '2026-12-01' }, 200);
      const vendorId = (await row(id)).vendorId;
      expect(vendorId).not.toBeNull();

      const res = await act(id, 'reextract', {}, 200);
      expect(res.body).toMatchObject({
        status: 'processing',
        extractionStatus: 'pending',
        version: 3,
        flags: [],
        extracted: null,
      });
      const boss = await t.app.get(JobsService).ready();
      const jobs = await boss.findJobs(EXTRACT_QUEUE, { key: id });
      expect(jobs.length).toBeGreaterThan(0);

      await extractWith(t, id, asmWireOutput());
      const after = await row(id);
      expect(after).toMatchObject({
        status: 'needs_review',
        extractionStatus: 'succeeded',
        vendorId,
        notes: expectedExtraction('asm').notes,
        dueDateSource: 'printed',
        version: 3, // the worker doesn't change it
      });
      expect(after.amountDue?.toFixed()).toBe('15617.79');
      expect((await events(id))[0]?.type).toBe('extracted');
    });
  });

  describe('re-extract changing the number', () => {
    it('re-evaluates the invoices that shared the old number', async () => {
      const first = await ingestFixture(t, 'asm');
      const second = await ingestFixture(t, 'asm', { pdf: pdfVariant('asm', '2') });
      expect(await codesOf(first)).toContain('DUPLICATE_NUMBER');

      await act(second, 'reextract', {}, 200);
      await extractWith(t, second, { ...asmWireOutput(), invoiceNumber: 'SI-000218720' });
      expect(await codesOf(first)).not.toContain('DUPLICATE_NUMBER');
      expect(await codesOf(second)).not.toContain('DUPLICATE_NUMBER');
    });
  });

  describe('reads', () => {
    it('GET …/events: newest first, with user and vendor names', async () => {
      const id = await ingestFixture(t, 'asm');
      const vendorId = await createVendor({ name: 'Aviation Services Management' }); // matches
      await edit(id, { notes: 'Checked' }, 200);
      await act(id, 'approve', {}, 200);

      const list = await events(id);
      expect(list.map((e) => e.type)).toEqual([
        'approved',
        'edited',
        'vendor_linked',
        'extracted',
        'received',
      ]);
      expect(list[0]).toMatchObject({
        user: { id: user.id, name: 'Nino Clerk' },
        vendor: null,
        data: { overriddenFlags: [] },
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(list[2]).toMatchObject({
        user: null,
        vendor: { id: vendorId, name: 'Aviation Services Management' },
        data: { vendorId, method: 'name' },
      });
      await get('/api/invoices/00000000-0000-0000-0000-000000000000/events').expect(404);
    });

    it('GET …/next-to-review: To review order, without processing invoices or `after`', async () => {
      const asm = await ingestFixture(t, 'asm'); // dispute deadline 2026-09-30
      const aeg = await ingestFixture(t, 'aeg'); // 2026-09-24
      const petrocas = await ingestFixture(t, 'petrocas'); // none: last
      const reading = await ingestPdf(t, { pdf: pdfVariant('asm', 'r') }); // processing
      await t.prisma.invoice.update({
        where: { id: reading },
        data: { disputeDeadline: new Date('2026-09-01T00:00:00Z') },
      });
      const next = async (query = '') =>
        (await get(`/api/invoices/next-to-review${query}`).expect(200)).body.id as string | null;

      expect(await next()).toBe(aeg);
      expect(await next(`?after=${aeg}`)).toBe(asm);
      await t.prisma.invoice.update({ where: { id: aeg }, data: { status: 'unpaid' } });
      expect(await next()).toBe(asm);
      expect(await next(`?after=${asm}`)).toBe(petrocas);
      await t.prisma.invoice.updateMany({
        where: { id: { in: [asm, petrocas] } },
        data: { status: 'rejected' },
      });
      expect(await next()).toBeNull();
      await get('/api/invoices/next-to-review?after=nope').expect(400);
    });

    it('?extraction=failed lists, counts and exports only unreadable invoices', async () => {
      const ok = await ingestFixture(t, 'asm');
      const failed = await ingestPdf(t, { pdf: pdfVariant('aeg', 'f') });
      await t.prisma.invoice.update({
        where: { id: failed },
        data: { status: 'needs_review', extractionStatus: 'failed', extractionError: 'boom' },
      });

      const list = await get('/api/invoices?extraction=failed').expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([failed]);
      expect((await get('/api/invoices').expect(200)).body.total).toBe(2);
      const summary = await get('/api/invoices/summary?extraction=failed').expect(200);
      expect(summary.body.counts).toMatchObject({ needs_review: 1, all: 1 });
      const csv = await get('/api/invoices/export.csv?extraction=failed').expect(200);
      expect(csv.text).toContain(failed);
      expect(csv.text).not.toContain(ok);
      await get('/api/invoices?extraction=succeeded').expect(400);
    });
  });

  describe('vendor link and trust carry the version', () => {
    it('link and trust check and increment it; trusting an account already on file does not', async () => {
      const id = await ingestFixture(t, 'aeg');
      const post = (path: string, body: object) =>
        t.http().post(`/api/invoices/${id}${path}`).set('Cookie', cookie).send(body);

      await post('/vendor', { version: 1, create: { name: 'AEG Fuels' } }).expect(409);
      const linked = await post('/vendor', { version: 0, create: { name: 'AEG Fuels' } }).expect(
        200,
      );
      expect(linked.body.version).toBe(1);

      const stale = await post('/trust-bank-details', { version: 0 }).expect(409);
      expect(conflict(stale.body).code).toBe('STALE');
      expect((await post('/trust-bank-details', { version: 1 }).expect(200)).body.version).toBe(2);
      // Already trusted: nothing changes, so the version stays.
      expect((await post('/trust-bank-details', { version: 2 }).expect(200)).body.version).toBe(2);
    });
  });
});
