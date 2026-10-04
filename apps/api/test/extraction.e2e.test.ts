import { emptyExtractionOutputV1 } from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractionHandler } from '../src/extraction/extraction.handler.js';
import { EXTRACT_QUEUE } from '../src/extraction/extraction-queue.js';
import {
  type ExtractionResult,
  INVOICE_EXTRACTOR,
  type InvoiceExtractor,
  NonRetryableExtractionError,
} from '../src/extraction/invoice-extractor.js';
import {
  GIVE_UP_AFTER_MS,
  GIVE_UP_ERROR,
  RecoverySweep,
  STUCK_AFTER_MS,
} from '../src/extraction/recovery-sweep.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  type TestApp,
  asmWireOutput,
  createTestApp,
  fixture,
  postMailgun,
  resetDatabase,
  resetJobs,
  waitFor,
} from './helpers.js';

const asmPdf = { filename: 'asm.pdf', contentType: 'application/pdf', data: fixture('asm.pdf') };

async function ingestOne(t: TestApp): Promise<string> {
  const res = await postMailgun(t, { attachments: [asmPdf] }).expect(200);
  return res.body.invoiceIds[0] as string;
}

/** What the Anthropic extractor would return for asm.pdf. */
const asmResult = (): ExtractionResult => ({
  model: 'claude-sonnet-5-5',
  promptVersion: 'extract-v1',
  raw: asmWireOutput(),
  usage: { inputTokens: 6013, outputTokens: 591 },
  durationMs: 8012,
});

/** needs_review and evaluated: with no vendors, every evaluated invoice has at least NEW_VENDOR. */
async function waitForReview(t: TestApp, invoiceId: string, timeoutMs?: number) {
  return waitFor(
    async () => {
      const row = await t.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      return (
        row.status === 'needs_review' && Array.isArray(row.flags) && row.flags.length > 0 && row
      );
    },
    { timeoutMs },
  );
}

function flagCodes(flags: unknown): string[] {
  return (flags as { code: string }[]).map((flag) => flag.code);
}

async function eventsOf(t: TestApp, invoiceId: string) {
  return t.prisma.invoiceEvent.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
}

describe('extraction worker (pg-boss)', () => {
  let t: TestApp;
  let extractor: InvoiceExtractor;

  beforeAll(async () => {
    // Workers on; 1 s base retry delay so three attempts fit in a test.
    t = await createTestApp({
      env: { WORKERS_ENABLED: 'true', EXTRACTION_RETRY_DELAY_SECONDS: '1' },
    });
    extractor = t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves the invoice to needs_review with an `extracted` event', async () => {
    const spy = vi.spyOn(extractor, 'extract');
    const invoiceId = await ingestOne(t);

    const invoice = await waitForReview(t, invoiceId);
    expect(invoice).toMatchObject({
      extractionStatus: 'succeeded',
      extractionModel: 'stub',
      extractionPromptVersion: 'stub',
      extractionRaw: emptyExtractionOutputV1(),
      extractionError: null,
      extractedAt: expect.any(Date),
      // The stub extracts nothing: every field empty.
      vendorName: null,
      invoiceDate: null,
      totalAmount: null,
      lineItems: [],
      bankDetails: null,
    });
    // ...so T04's evaluation flags every required field.
    expect(flagCodes(invoice.flags)).toEqual([
      'MISSING_REQUIRED',
      'MISSING_REQUIRED',
      'MISSING_REQUIRED',
      'MISSING_REQUIRED',
      'MISSING_REQUIRED',
      'MISSING_REQUIRED',
      'NOT_BILLED_TO_CAMEX',
      'NOT_AN_INVOICE',
      'NEW_VENDOR',
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const input = spy.mock.calls[0]?.[0];
    expect(input?.pdf.equals(asmPdf.data)).toBe(true);
    expect(input).toMatchObject({
      fileName: 'asm.pdf',
      email: { from: 'billing@vendor.example', subject: 'Invoice 42' },
      invoiceId,
    });

    const events = await t.prisma.invoiceEvent.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['received', 'extracted']);
    expect(events[1]).toMatchObject({
      userId: null,
      data: {
        model: 'stub',
        promptVersion: 'stub',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 500,
      },
    });
  });

  it('stores every normalized field, the raw output and the token usage', async () => {
    vi.spyOn(extractor, 'extract').mockResolvedValue(asmResult());
    const invoiceId = await ingestOne(t);
    const invoice = await waitForReview(t, invoiceId);

    expect(invoice).toMatchObject({
      extractionStatus: 'succeeded',
      extractionModel: 'claude-sonnet-5-5',
      extractionPromptVersion: 'extract-v1',
      extractionRaw: asmWireOutput(),
      documentType: 'invoice',
      vendorName: 'Aviation Services Management FZE',
      vendorTaxId: '100000894400003',
      invoiceNumber: 'SI-000218719',
      paymentTermsDays: 0,
      disputeWindowDays: 14,
      category: 'fuel',
      airportIcao: 'LHBP',
      airportIata: 'BUD',
      // normalized from the wire's "4LCME" and ["CMS503/4"]
      aircraftRegistration: '4L-CME',
      flightNumbers: ['CMS503', 'CMS504'],
      currency: 'USD',
      amountDueCurrency: 'USD',
      notes: expect.stringMatching(/^Transfer fees/),
      vendorId: null,
      // printed on the invoice, so kept as printed (T04)
      dueDateSource: 'printed',
    });
    // date columns
    expect(invoice.invoiceDate?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(invoice.serviceDate?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(invoice.dueDate?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
    // derived by T04's evaluation: invoice date + 14-day dispute window
    expect(invoice.disputeDeadline?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    // numeric columns
    expect(invoice.totalAmount?.toFixed()).toBe('15617.79');
    expect(invoice.amountDue?.toFixed()).toBe('15617.79');
    expect(invoice.taxAmount?.toFixed()).toBe('0');
    // jsonb: snake_case keys, decimals as the strings returned
    expect(invoice.lineItems).toEqual([
      {
        kind: 'item',
        description: 'Fuel',
        quantity: '2814.2691',
        uom: 'USG',
        unit_price: '5.5495',
        amount: '15617.79',
      },
    ]);
    expect(invoice.bankDetails).toEqual({
      beneficiary: null,
      bank_name: 'Standard Chartered Bank',
      iban: 'AE300440000101236468501',
      account_number: null,
      swift: 'SCBLAEADXXX',
      routing_number: null,
      currency: 'USD',
    });

    const events = await eventsOf(t, invoiceId);
    expect(events.map((e) => e.type)).toEqual(['received', 'extracted']);
    expect(events[1]?.data).toEqual({
      model: 'claude-sonnet-5-5',
      promptVersion: 'extract-v1',
      inputTokens: 6013,
      outputTokens: 591,
      durationMs: 8012,
    });
  });

  it('a non-retryable error fails the extraction after one attempt and completes the job', async () => {
    const raw = { documentType: 'invoice', vendorNa: '' };
    const spy = vi.spyOn(extractor, 'extract').mockRejectedValue(
      new NonRetryableExtractionError('Model output was cut off at max_tokens (8192)', {
        raw,
        model: 'claude-sonnet-5-5',
        promptVersion: 'extract-v1',
      }),
    );
    const invoiceId = await ingestOne(t);
    const invoice = await waitForReview(t, invoiceId);

    expect(invoice).toMatchObject({
      extractionStatus: 'failed',
      extractionError: 'Model output was cut off at max_tokens (8192)',
      extractionRaw: raw,
      extractionModel: 'claude-sonnet-5-5',
      extractionPromptVersion: 'extract-v1',
      extractedAt: null,
    });
    const events = await eventsOf(t, invoiceId);
    expect(events.map((e) => e.type)).toEqual(['received', 'extraction_failed']);
    expect(events[1]?.data).toEqual({
      error: 'Model output was cut off at max_tokens (8192)',
      attempts: 1,
      retryable: false,
    });

    // Completed, not failed: pg-boss has nothing to retry.
    const boss = await t.app.get(JobsService).ready();
    const jobs = await waitFor(async () => {
      const found = await boss.findJobs(EXTRACT_QUEUE, { key: invoiceId });
      return found[0]?.state === 'completed' && found;
    });
    expect(jobs.map((j) => [j.state, j.retryCount])).toEqual([['completed', 0]]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retryable errors get 3 attempts, then extraction failed, needs_review, one `extraction_failed`', async () => {
    const spy = vi.spyOn(extractor, 'extract').mockRejectedValue(new Error('model unavailable'));
    const invoiceId = await ingestOne(t);

    const invoice = await waitFor(
      async () => {
        const row = await t.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
        return row.status === 'needs_review' && row;
      },
      { timeoutMs: 25_000 },
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(invoice).toMatchObject({
      extractionStatus: 'failed',
      extractionError: 'model unavailable',
      extractionRaw: null,
    });

    const events = await t.prisma.invoiceEvent.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['received', 'extraction_failed']);
    expect(events[1]?.data).toEqual({ error: 'model unavailable', attempts: 3 });

    // pg-boss records the job itself as failed after its retries, once the handler has thrown
    // (after the invoice is failed and evaluated, so a moment after needs_review).
    const boss = await t.app.get(JobsService).ready();
    const jobs = await waitFor(async () => {
      const found = await boss.findJobs(EXTRACT_QUEUE, { key: invoiceId });
      return found[0]?.state !== 'active' && found;
    });
    expect(jobs.map((j) => [j.state, j.retryCount])).toEqual([['failed', 2]]);
  }, 30_000);

  it('is idempotent: an invoice that is no longer processing is left alone', async () => {
    const spy = vi.spyOn(extractor, 'extract');
    const invoiceId = await ingestOne(t);
    await waitFor(async () => {
      const row = await t.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      return row.status === 'needs_review';
    });

    await t.app
      .get(ExtractionHandler)
      .handle({ data: { invoiceId }, retryCount: 0, retryLimit: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await t.prisma.invoiceEvent.count({ where: { invoiceId } })).toBe(2);
  });
});

describe('recovery sweep', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(); // workers off: jobs stay queued for inspection
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
  });

  it('re-enqueues invoices stuck in processing for over 10 minutes, once', async () => {
    const stuckId = await ingestOne(t);
    const freshId = await ingestOne(t);
    // Simulate a lost job: no queued job and an old updated_at.
    await resetJobs(t);
    await t.prisma.$executeRaw`
      UPDATE invoices SET updated_at = now() - make_interval(secs => ${STUCK_AFTER_MS / 1000 + 60})
      WHERE id = ${stuckId}::uuid`;

    const sweep = t.app.get(RecoverySweep);
    expect(await sweep.run()).toEqual({ reenqueued: [stuckId], failed: [] });

    const boss = await t.app.get(JobsService).ready();
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: stuckId })).toHaveLength(1);
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: freshId })).toHaveLength(0);

    // Still stuck on the next run, but its job is queued: nothing new.
    expect(await sweep.run()).toEqual({ reenqueued: [], failed: [] });
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: stuckId })).toHaveLength(1);
  });

  it('ignores invoices that are not processing', async () => {
    const id = await ingestOne(t);
    await resetJobs(t);
    await t.prisma.$executeRaw`
      UPDATE invoices SET status = 'needs_review', updated_at = now() - interval '1 hour'
      WHERE id = ${id}::uuid`;
    expect(await t.app.get(RecoverySweep).run()).toEqual({ reenqueued: [], failed: [] });
  });

  it('gives up on invoices stuck for over 60 minutes: failed, needs_review, `extraction_failed`', async () => {
    const expiredId = await ingestOne(t);
    const stuckId = await ingestOne(t);
    await resetJobs(t);
    await t.prisma.$executeRaw`
      UPDATE invoices SET updated_at = now() - make_interval(secs => ${GIVE_UP_AFTER_MS / 1000 + 60})
      WHERE id = ${expiredId}::uuid`;
    await t.prisma.$executeRaw`
      UPDATE invoices SET updated_at = now() - interval '59 minutes'
      WHERE id = ${stuckId}::uuid`;

    expect(await t.app.get(RecoverySweep).run()).toEqual({
      reenqueued: [stuckId],
      failed: [expiredId],
    });

    const expired = await t.prisma.invoice.findUniqueOrThrow({ where: { id: expiredId } });
    expect(expired).toMatchObject({
      status: 'needs_review',
      extractionStatus: 'failed',
      extractionError: GIVE_UP_ERROR,
    });
    expect(GIVE_UP_ERROR).toBe('Extraction did not finish within 60 minutes');
    const events = await eventsOf(t, expiredId);
    expect(events.map((e) => e.type)).toEqual(['received', 'extraction_failed']);
    expect(events[1]?.data).toEqual({ error: GIVE_UP_ERROR, retryable: false });

    const boss = await t.app.get(JobsService).ready();
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: expiredId })).toHaveLength(0);
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: stuckId })).toHaveLength(1);
  });
});
