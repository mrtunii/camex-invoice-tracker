import { type ExtractedInvoice, invoiceDetailSchema } from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvaluationWorkers,
  REEVALUATE_CRON,
  REEVALUATE_QUEUE,
} from '../src/evaluation/evaluation.workers.js';
import { InvoiceEvaluator } from '../src/evaluation/invoice-evaluator.js';
import { ExtractionHandler } from '../src/extraction/extraction.handler.js';
import {
  INVOICE_EXTRACTOR,
  type InvoiceExtractor,
  NonRetryableExtractionError,
} from '../src/extraction/invoice-extractor.js';
import { normalizeExtraction } from '../src/extraction/normalize.js';
import { GIVE_UP_AFTER_MS, RecoverySweep } from '../src/extraction/recovery-sweep.js';
import { extractedInvoiceColumns } from '../src/invoices/invoice-columns.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  type FixtureName,
  type TestApp,
  createTestApp,
  createUser,
  expectedExtraction,
  extractWith,
  fixture,
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

describe('invoice evaluation', () => {
  let t: TestApp;
  let cookie: string;
  let evaluator: InvoiceEvaluator;

  beforeAll(async () => {
    t = await createTestApp(); // workers off: tests drive the handler and the evaluator
    evaluator = t.app.get(InvoiceEvaluator);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    await createUser(t.prisma, { email: 'clerk@camex.aero' });
    cookie = await login(t, 'clerk@camex.aero');
    setToday(t, '2026-10-02');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = (id: string) => t.prisma.invoice.findUniqueOrThrow({ where: { id } });
  const codesOf = async (id: string) => flagCodes((await row(id)).flags);
  const detail = async (id: string) =>
    invoiceDetailSchema.parse(
      (await t.http().get(`/api/invoices/${id}`).set('Cookie', cookie).expect(200)).body,
    );
  const createVendor = async (body: object) =>
    (await t.http().post('/api/vendors').set('Cookie', cookie).send(body).expect(201)).body
      .id as string;
  const linkEvents = (invoiceId: string) =>
    t.prisma.invoiceEvent.findMany({ where: { invoiceId, type: 'vendor_linked' } });

  describe('the fixtures end to end (T04 "Done when", with the clock at 2026-10-02)', () => {
    it('no vendors → name match on vendor creation → trust clears → removal brings it back', async () => {
      const ids = {} as Record<FixtureName, string>;
      for (const name of ['asm', 'petrocas', 'aeg'] as const)
        ids[name] = await ingestFixture(t, name);

      // 1. No vendors.
      const asm = await detail(ids.asm);
      expect(asm).toMatchObject({
        vendor: null,
        dueDate: '2026-09-16',
        dueDateSource: 'printed',
        disputeDeadline: '2026-09-30',
      });
      expect(asm.flags.map((f) => `${f.code}:${f.severity}`)).toEqual([
        'DISPUTE_SOON:warning',
        'NEW_VENDOR:info',
      ]);
      expect(asm.flags[0]?.message).toBe('Dispute window ended 2026-09-30');
      const petrocas = await detail(ids.petrocas);
      expect(petrocas.flags.map((f) => `${f.code}:${f.severity}:${f.field ?? ''}`)).toEqual([
        'MISSING_REQUIRED:error:dueDate',
        'PAY_IN_OTHER_CURRENCY:info:amountDueCurrency',
        'NEW_VENDOR:info:vendorName',
      ]);
      const aeg = await detail(ids.aeg);
      expect(aeg.flags.map((f) => f.message)).toEqual([
        'Dispute window ended 2026-09-24',
        'No vendor matched: link an existing vendor or create one',
      ]);

      // 2. Create the three vendors: each invoice links by name; BANK_FIRST_SEEN replaces NEW_VENDOR.
      const vendorIds = {
        asm: await createVendor({ name: 'Aviation Services Management FZE' }),
        petrocas: await createVendor({
          name: 'Petrocas Fuel Services Georgia LLC',
          defaultPaymentTermsDays: 10,
        }),
        aeg: await createVendor({ name: 'AEG Fuels Ireland Limited' }),
      };
      for (const name of ['asm', 'petrocas', 'aeg'] as const) {
        const linked = await detail(ids[name]);
        expect(linked.vendor?.id).toBe(vendorIds[name]);
        expect(await linkEvents(ids[name])).toMatchObject([
          { userId: null, data: { vendorId: vendorIds[name], method: 'name' } },
        ]);
      }
      expect(await codesOf(ids.asm)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
      expect(await codesOf(ids.aeg)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
      const derived = await detail(ids.petrocas);
      expect(derived).toMatchObject({ dueDate: '2026-10-12', dueDateSource: 'vendor_default' });
      expect(derived.flags.map((f) => f.code)).toEqual([
        'BANK_FIRST_SEEN',
        'DUE_DATE_DERIVED',
        'PAY_IN_OTHER_CURRENCY',
      ]);

      // 3. Trust AEG's bank details: the flag clears.
      await t
        .http()
        .post(`/api/invoices/${ids.aeg}/trust-bank-details`)
        .set('Cookie', cookie)
        .expect(200);
      expect(await codesOf(ids.aeg)).toEqual(['DISPUTE_SOON']);

      // A second AEG invoice paying into another account: BANK_UNKNOWN; the first stays clean.
      const second = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', '2'),
        wire: {
          invoiceNumber: '3110999',
          bankDetails: {
            ...wireFromExpected(expectedExtraction('aeg')).bankDetails,
            accountNumber: '1111111111',
          },
        },
      });
      expect((await detail(second)).flags[0]).toMatchObject({
        code: 'BANK_UNKNOWN',
        severity: 'error',
      });
      expect(await codesOf(ids.aeg)).toEqual(['DISPUTE_SOON']);

      // 4. Remove the account: BANK_FIRST_SEEN comes back.
      const vendor = (
        await t.http().get(`/api/vendors/${vendorIds.aeg}`).set('Cookie', cookie).expect(200)
      ).body;
      await t
        .http()
        .delete(
          `/api/vendors/${vendorIds.aeg}/bank-accounts/${vendor.bankAccounts[0].id as string}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(await codesOf(ids.aeg)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
      expect(await codesOf(second)).toEqual(['BANK_FIRST_SEEN', 'DISPUTE_SOON']);
    });
  });

  describe('vendor matching', () => {
    it('by name, ignoring case, punctuation and legal forms', async () => {
      const vendorId = await createVendor({ name: 'AVIATION SERVICES MANAGEMENT' });
      const id = await ingestFixture(t, 'asm');
      expect((await row(id)).vendorId).toBe(vendorId);
      expect(await linkEvents(id)).toMatchObject([
        { userId: null, data: { vendorId, method: 'name' } },
      ]);
    });

    it('by alias', async () => {
      const vendorId = await createVendor({
        name: 'ASM',
        aliases: ['Aviation Services Management F.Z.E.'],
      });
      const id = await ingestFixture(t, 'asm');
      expect((await row(id)).vendorId).toBe(vendorId);
      expect(await linkEvents(id)).toMatchObject([{ data: { vendorId, method: 'alias' } }]);
    });

    it('by the sender’s email domain when the name doesn’t match', async () => {
      const vendorId = await createVendor({ name: 'ASM', emailDomains: ['asm-aviation.example'] });
      const id = await ingestFixture(t, 'asm');
      expect((await row(id)).vendorId).toBe(vendorId);
      expect(await linkEvents(id)).toMatchObject([{ data: { vendorId, method: 'email_domain' } }]);
    });

    it('a subdomain of a vendor domain matches too; the most specific vendor domain wins', async () => {
      const aeg = await createVendor({ name: 'AEG', emailDomains: ['aegfuels.example'] });
      const desk = await createVendor({
        name: 'AEG Billing Desk',
        emailDomains: ['billing.aegfuels.example'],
      });
      const ingestFrom = (from: string) =>
        ingestFixture(t, 'aeg', {
          pdf: pdfVariant('aeg', from),
          from,
          wire: { vendorName: 'Unknown Seller', invoiceNumber: from },
        });

      const viaMail = await ingestFrom('ar@mail.aegfuels.example');
      expect((await row(viaMail)).vendorId).toBe(aeg);
      expect(await linkEvents(viaMail)).toMatchObject([
        { data: { vendorId: aeg, method: 'email_domain' } },
      ]);
      expect((await row(await ingestFrom('ar@eu.billing.aegfuels.example'))).vendorId).toBe(desk);
      // Only whole labels count: fakeaegfuels.example is not under aegfuels.example.
      expect((await row(await ingestFrom('ar@fakeaegfuels.example'))).vendorId).toBeNull();
    });

    it('a name match beats a domain match', async () => {
      await createVendor({ name: 'Someone Else', emailDomains: ['asm-aviation.example'] });
      const byName = await createVendor({ name: 'Aviation Services Management' });
      const id = await ingestFixture(t, 'asm');
      expect((await row(id)).vendorId).toBe(byName);
      expect(await linkEvents(id)).toMatchObject([{ data: { method: 'name' } }]);
    });

    it('manual uploads never match by domain', async () => {
      await createVendor({ name: 'ASM', emailDomains: ['asm-aviation.example'] });
      // The uploader's address is the "from" of a manual upload.
      await createUser(t.prisma, { email: 'ops@asm-aviation.example' });
      const uploader = await login(t, 'ops@asm-aviation.example');
      const res = await t
        .http()
        .post('/api/invoices/upload')
        .set('Cookie', uploader)
        .attach('files', fixture('asm.pdf'), {
          filename: 'asm.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      const id = res.body.invoiceIds[0] as string;
      const email = await t.prisma.inboundEmail.findUniqueOrThrow({
        where: { id: res.body.inboundEmailId as string },
      });
      expect(email).toMatchObject({ provider: 'manual', fromAddress: 'ops@asm-aviation.example' });
      await extractWith(t, id, {
        ...wireFromExpected(expectedExtraction('asm')),
        vendorName: 'Unknown Seller',
      });
      expect((await row(id)).vendorId).toBeNull();
      expect(await codesOf(id)).toContain('NEW_VENDOR');
    });

    it('own domains (and their subdomains) never match', async () => {
      // The API refuses Camex domains on a vendor, so this vendor is written directly.
      await t.prisma.vendor.create({
        data: { name: 'Misconfigured', emailDomains: ['camex.aero', 'in.camex.aero'] },
      });
      for (const from of ['Forwarder <invoices@camex.aero>', 'fwd@in.camex.aero']) {
        const id = await ingestFixture(t, 'asm', {
          pdf: pdfVariant('asm', from),
          from,
          wire: { vendorName: 'Unknown Seller', invoiceNumber: from },
        });
        expect((await row(id)).vendorId).toBeNull();
      }
    });

    it('only unlinked invoices in needs_review are matched', async () => {
      const id = await ingestFixture(t, 'asm');
      await t.prisma.invoice.update({ where: { id }, data: { status: 'unpaid' } });
      await createVendor({ name: 'Aviation Services Management' });
      expect((await row(id)).vendorId).toBeNull();
    });
  });

  describe('duplicates', () => {
    it('the same PDF twice: both DUPLICATE_FILE; rejecting one clears the other', async () => {
      const a = await ingestFixture(t, 'asm');
      const b = await ingestFixture(t, 'asm');
      // Same file, so also the same number from the same vendor (by name: both unlinked).
      const both = ['DUPLICATE_FILE', 'DUPLICATE_NUMBER', 'DISPUTE_SOON', 'NEW_VENDOR'];
      expect(await codesOf(a)).toEqual(both);
      expect(await codesOf(b)).toEqual(both);

      await t.prisma.invoice.update({ where: { id: b }, data: { status: 'rejected' } });
      await evaluator.evaluateWithRelated(b);
      expect(await codesOf(a)).toEqual(['DISPUTE_SOON', 'NEW_VENDOR']);
    });

    it('a duplicate file counts in any status, including paid', async () => {
      const a = await ingestFixture(t, 'asm');
      await t.prisma.invoice.update({ where: { id: a }, data: { status: 'paid' } });
      const b = await ingestFixture(t, 'asm');
      expect(await codesOf(b)).toContain('DUPLICATE_FILE');
    });

    it('same vendor + number: both DUPLICATE_NUMBER; another vendor with the same number: none', async () => {
      const a = await ingestFixture(t, 'aeg');
      const b = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', 'b'),
        wire: { invoiceNumber: '3110 713' },
      });
      expect(await codesOf(a)).toContain('DUPLICATE_NUMBER');
      expect(await codesOf(b)).toContain('DUPLICATE_NUMBER');
      expect(await codesOf(a)).not.toContain('DUPLICATE_FILE');

      const other = await ingestFixture(t, 'asm', { wire: { invoiceNumber: '3110713' } });
      expect(await codesOf(other)).not.toContain('DUPLICATE_NUMBER');
    });

    it('numbers match by key: case and any whitespace (incl. no-break spaces) ignored', async () => {
      const a = await ingestFixture(t, 'aeg', { wire: { invoiceNumber: 'inv\u00a03110 713' } });
      const b = await ingestFixture(t, 'aeg', {
        pdf: pdfVariant('aeg', 'b'),
        wire: { invoiceNumber: 'INV3110713' },
      });
      expect(await codesOf(a)).toContain('DUPLICATE_NUMBER');
      expect(await codesOf(b)).toContain('DUPLICATE_NUMBER');
    });

    it('linked to the same vendor counts; linked to different vendors does not', async () => {
      const aegA = await createVendor({ name: 'AEG Fuels Ireland Limited' });
      const a = await ingestFixture(t, 'aeg');
      const b = await ingestFixture(t, 'aeg', { pdf: pdfVariant('aeg', 'b') });
      expect((await row(b)).vendorId).toBe(aegA);
      expect(await codesOf(b)).toContain('DUPLICATE_NUMBER');

      // Moving b to another vendor (manual link) clears both.
      const other = await createVendor({ name: 'AEG UK' });
      await t.prisma.invoice.update({ where: { id: b }, data: { vendorId: other } });
      await evaluator.evaluateWithRelated(b);
      expect(await codesOf(a)).not.toContain('DUPLICATE_NUMBER');
      expect(await codesOf(b)).not.toContain('DUPLICATE_NUMBER');
    });

    describe('convergence when two duplicates finish extraction at the same time', () => {
      /** The extraction handler's write, without its evaluation. */
      async function writeExtraction(id: string, extracted: ExtractedInvoice) {
        await t.prisma.invoice.update({
          where: { id },
          data: {
            ...extractedInvoiceColumns(extracted),
            extractionStatus: 'succeeded',
            status: 'needs_review',
          },
        });
      }

      it.each([
        ['A commits first', 0],
        ['B commits first', 1],
      ] as const)('%s: whichever commits last re-flags the other', async (_label, firstIndex) => {
        const ids = [
          await ingestPdf(t, { pdf: pdfVariant('aeg', 'A') }),
          await ingestPdf(t, { pdf: pdfVariant('aeg', 'B') }),
        ];
        const first = ids[firstIndex] ?? '';
        const last = ids[1 - firstIndex] ?? '';
        const extracted = normalizeExtraction(wireFromExpected(expectedExtraction('aeg')));

        // The first commits and evaluates itself while the other is still processing...
        await writeExtraction(first, extracted);
        await evaluator.evaluateWithRelated(first);
        expect(await codesOf(first)).not.toContain('DUPLICATE_NUMBER');
        // ...then the other commits and evaluates: it sees the first, and re-flags it.
        await writeExtraction(last, extracted);
        await evaluator.evaluateWithRelated(last);

        expect(await codesOf(first)).toContain('DUPLICATE_NUMBER');
        expect(await codesOf(last)).toContain('DUPLICATE_NUMBER');
      });

      it('also when both commit before either evaluates, in either evaluation order', async () => {
        for (const order of [
          [0, 1],
          [1, 0],
        ] as const) {
          await resetDatabase(t.prisma);
          const ids = [
            await ingestPdf(t, { pdf: pdfVariant('aeg', `C${order[0]}`) }),
            await ingestPdf(t, { pdf: pdfVariant('aeg', `D${order[0]}`) }),
          ];
          const extracted = normalizeExtraction(wireFromExpected(expectedExtraction('aeg')));
          for (const id of ids) await writeExtraction(id, extracted);
          // Only one of them gets to evaluate (say the other's evaluation failed): still both.
          await evaluator.evaluateWithRelated(ids[order[0]] ?? '');
          for (const id of ids) expect(await codesOf(id)).toContain('DUPLICATE_NUMBER');
        }
      });
    });
  });

  describe('daily re-evaluation', () => {
    it('moving the clock flips DISPUTE_SOON', async () => {
      setToday(t, '2026-09-20');
      const id = await ingestFixture(t, 'asm'); // dispute deadline 2026-09-30
      expect(await codesOf(id)).toEqual(['NEW_VENDOR']);

      const workers = t.app.get(EvaluationWorkers);
      setToday(t, '2026-09-26');
      await workers.run();
      expect(await codesOf(id)).toEqual(['NEW_VENDOR']);

      setToday(t, '2026-09-27');
      await workers.run();
      expect((await row(id)).flags).toEqual([
        {
          code: 'DISPUTE_SOON',
          severity: 'warning',
          field: 'disputeDeadline',
          message: 'Dispute window ends 2026-09-30',
        },
        expect.objectContaining({ code: 'NEW_VENDOR' }),
      ]);

      setToday(t, '2026-10-01');
      await workers.run();
      expect((await row(id)).flags).toMatchObject([
        { code: 'DISPUTE_SOON', message: 'Dispute window ended 2026-09-30' },
        { code: 'NEW_VENDOR' },
      ]);
    });

    it('covers needs_review and unpaid invoices only; FUTURE_DATE flips too', async () => {
      setToday(t, '2026-09-10');
      const future = await ingestFixture(t, 'asm'); // invoice date 2026-09-16
      const paid = await ingestFixture(t, 'aeg'); // invoice date 2026-09-14
      expect(await codesOf(future)).toContain('FUTURE_DATE');
      await t.prisma.invoice.update({ where: { id: paid }, data: { status: 'paid' } });
      const paidFlags = (await row(paid)).flags;

      setToday(t, '2026-09-16');
      const updatedBefore = (await row(paid)).updatedAt;
      await t.app.get(EvaluationWorkers).run();
      expect(await codesOf(future)).not.toContain('FUTURE_DATE');
      expect((await row(paid)).flags).toEqual(paidFlags);
      expect((await row(paid)).updatedAt).toEqual(updatedBefore);
    });

    it('leaves unchanged invoices untouched (no write, updated_at kept)', async () => {
      const id = await ingestFixture(t, 'asm');
      const before = await row(id);
      await t.app.get(EvaluationWorkers).run();
      expect((await row(id)).updatedAt).toEqual(before.updatedAt);
    });
  });

  describe('extraction triggers evaluation', () => {
    it('after success: vendor, derived dates and flags are set', async () => {
      const vendorId = await createVendor({
        name: 'Petrocas Fuel Services Georgia',
        defaultPaymentTermsDays: 30,
      });
      const id = await ingestFixture(t, 'petrocas');
      const invoice = await detail(id);
      expect(invoice).toMatchObject({
        vendor: { id: vendorId, name: 'Petrocas Fuel Services Georgia' },
        dueDate: '2026-11-01',
        dueDateSource: 'vendor_default',
        disputeDeadline: null,
      });
      expect(invoice.flags.map((f) => f.code)).toEqual([
        'BANK_FIRST_SEEN',
        'DUE_DATE_DERIVED',
        'PAY_IN_OTHER_CURRENCY',
      ]);
    });

    it('after a non-retryable failure: EXTRACTION_FAILED and MISSING_REQUIRED', async () => {
      const id = await ingestPdf(t, { pdf: fixture('aeg.pdf'), from: 'ar@aegfuels.example' });
      vi.spyOn(t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR), 'extract').mockRejectedValue(
        new NonRetryableExtractionError('refused', null),
      );
      await t.app
        .get(ExtractionHandler)
        .handle({ data: { invoiceId: id }, retryCount: 0, retryLimit: 2 });
      const invoice = await detail(id);
      expect(invoice.extractionStatus).toBe('failed');
      expect(invoice.flags.map((f) => `${f.code}:${f.field ?? ''}`)).toEqual([
        'EXTRACTION_FAILED:',
        'MISSING_REQUIRED:vendorName',
        'MISSING_REQUIRED:invoiceNumber',
        'MISSING_REQUIRED:invoiceDate',
        'MISSING_REQUIRED:dueDate',
        'MISSING_REQUIRED:amountDue',
        'MISSING_REQUIRED:amountDueCurrency',
        'NOT_BILLED_TO_CAMEX:billToName',
        'NEW_VENDOR:vendorName',
      ]);
    });

    it('after the final retryable attempt fails, and a failed invoice can still match by domain', async () => {
      const vendorId = await createVendor({ name: 'AEG', emailDomains: ['aegfuels.example'] });
      const id = await ingestPdf(t, { pdf: fixture('aeg.pdf'), from: 'ar@aegfuels.example' });
      vi.spyOn(t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR), 'extract').mockRejectedValue(
        new Error('timeout'),
      );
      await expect(
        t.app
          .get(ExtractionHandler)
          .handle({ data: { invoiceId: id }, retryCount: 2, retryLimit: 2 }),
      ).rejects.toThrow('timeout');
      const invoice = await row(id);
      expect(invoice.vendorId).toBe(vendorId);
      expect(flagCodes(invoice.flags).slice(0, 2)).toEqual([
        'EXTRACTION_FAILED',
        'MISSING_REQUIRED',
      ]);
    });

    it('after the recovery sweep gives up', async () => {
      const id = await ingestPdf(t, { pdf: fixture('asm.pdf') });
      const now = new Date();
      await t.prisma
        .$executeRaw`UPDATE invoices SET updated_at = ${new Date(now.getTime() - GIVE_UP_AFTER_MS - 60_000)} WHERE id = ${id}::uuid`;
      const result = await t.app.get(RecoverySweep).run(now);
      expect(result.failed).toEqual([id]);
      expect(flagCodes((await row(id)).flags)[0]).toBe('EXTRACTION_FAILED');
    });

    it('a processing invoice has no flags', async () => {
      const id = await ingestPdf(t, { pdf: fixture('asm.pdf') });
      await evaluator.evaluateWithRelated(id);
      expect((await row(id)).flags).toEqual([]);
    });
  });

  describe('evaluation inside the extraction transaction', () => {
    const handler = () => t.app.get(ExtractionHandler);
    const extractor = () => t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR);
    const extractedAsm = () => ({
      model: 'claude-sonnet-5-5',
      promptVersion: 'extract-v1',
      raw: wireFromExpected(expectedExtraction('asm')),
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    });
    const eventCount = (invoiceId: string, type: 'extracted' | 'extraction_failed') =>
      t.prisma.invoiceEvent.count({ where: { invoiceId, type } });

    it('the committed needs_review row already has its flags (success and final failure)', async () => {
      // Without the post-commit pass, only what the extraction transaction itself wrote.
      vi.spyOn(evaluator, 'tryEvaluateWithRelated').mockResolvedValue();
      const ok = await ingestFixture(t, 'petrocas');
      expect(await row(ok)).toMatchObject({
        status: 'needs_review',
        extractionStatus: 'succeeded',
      });
      expect(await codesOf(ok)).toEqual([
        'MISSING_REQUIRED',
        'PAY_IN_OTHER_CURRENCY',
        'NEW_VENDOR',
      ]);

      const failed = await ingestPdf(t, { pdf: fixture('aeg.pdf') });
      vi.spyOn(extractor(), 'extract').mockRejectedValue(new Error('timeout'));
      await expect(
        handler().handle({ data: { invoiceId: failed }, retryCount: 2, retryLimit: 2 }),
      ).rejects.toThrow('timeout');
      expect(await row(failed)).toMatchObject({
        status: 'needs_review',
        extractionStatus: 'failed',
      });
      expect((await codesOf(failed))[0]).toBe('EXTRACTION_FAILED');
    });

    it('a throwing evaluation rolls the success write back; the attempt fails as retryable', async () => {
      const id = await ingestPdf(t, { pdf: fixture('asm.pdf') });
      vi.spyOn(extractor(), 'extract').mockResolvedValue(extractedAsm());
      vi.spyOn(evaluator, 'evaluate').mockRejectedValueOnce(new Error('evaluation broke'));

      await expect(
        handler().handle({ data: { invoiceId: id }, retryCount: 0, retryLimit: 2 }),
      ).rejects.toThrow('evaluation broke');
      expect(await row(id)).toMatchObject({
        status: 'processing',
        extractionStatus: 'pending',
        invoiceNumber: null,
        flags: [],
      });
      expect(await eventCount(id, 'extracted')).toBe(0);

      // pg-boss retries; this time the evaluation works.
      await handler().handle({ data: { invoiceId: id }, retryCount: 1, retryLimit: 2 });
      expect(await row(id)).toMatchObject({
        status: 'needs_review',
        invoiceNumber: 'SI-000218719',
      });
      expect(await codesOf(id)).toEqual(['DISPUTE_SOON', 'NEW_VENDOR']);
      expect(await eventCount(id, 'extracted')).toBe(1);
    });

    it('a throwing evaluation rolls the final-failure write back; the invoice stays processing', async () => {
      const id = await ingestPdf(t, { pdf: fixture('asm.pdf') });
      vi.spyOn(extractor(), 'extract').mockRejectedValue(new Error('timeout'));
      vi.spyOn(evaluator, 'evaluate').mockRejectedValueOnce(new Error('evaluation broke'));

      await expect(
        handler().handle({ data: { invoiceId: id }, retryCount: 2, retryLimit: 2 }),
      ).rejects.toThrow('evaluation broke');
      expect(await row(id)).toMatchObject({ status: 'processing', extractionStatus: 'pending' });
      expect(await eventCount(id, 'extraction_failed')).toBe(0);
    });

    it('the recovery sweep skips an invoice whose evaluation throws and gives up on the rest', async () => {
      const now = new Date();
      const old = new Date(now.getTime() - GIVE_UP_AFTER_MS - 60_000);
      const ids = [
        await ingestPdf(t, { pdf: pdfVariant('asm', '1') }),
        await ingestPdf(t, { pdf: pdfVariant('asm', '2') }),
      ];
      for (const [i, id] of ids.entries()) {
        // Distinct ages so the sweep's order (oldest first) is known.
        await t.prisma
          .$executeRaw`UPDATE invoices SET updated_at = ${new Date(old.getTime() - (2 - i) * 1000)} WHERE id = ${id}::uuid`;
      }
      vi.spyOn(evaluator, 'evaluate').mockRejectedValueOnce(new Error('evaluation broke'));

      const result = await t.app.get(RecoverySweep).run(now);
      expect(result.failed).toEqual([ids[1]]);
      expect((await row(ids[0] ?? '')).status).toBe('processing');
      expect(await codesOf(ids[1] ?? '')).toContain('EXTRACTION_FAILED');
    });
  });
});

describe('daily re-evaluation schedule (workers on)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { WORKERS_ENABLED: 'true' } });
  });
  afterAll(() => t.close());

  it('is registered at 00:05 Asia/Tbilisi', async () => {
    const boss = await t.app.get(JobsService).ready();
    const schedules = await boss.getSchedules(REEVALUATE_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      name: REEVALUATE_QUEUE,
      cron: REEVALUATE_CRON,
      timezone: 'Asia/Tbilisi',
      options: expect.objectContaining({ tz: 'Asia/Tbilisi', missed: 'once' }),
    });
    expect(REEVALUATE_CRON).toBe('5 0 * * *');
  });
});
