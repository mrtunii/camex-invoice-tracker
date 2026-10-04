import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractionHandler } from '../src/extraction/extraction.handler.js';
import { EXTRACT_QUEUE } from '../src/extraction/extraction-queue.js';
import { INVOICE_EXTRACTOR, type InvoiceExtractor } from '../src/extraction/invoice-extractor.js';
import { RecoverySweep, STUCK_AFTER_MS } from '../src/extraction/recovery-sweep.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  type TestApp,
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

describe('extraction worker (pg-boss, stub extractor)', () => {
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

    const invoice = await waitFor(async () => {
      const row = await t.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      return row.status === 'needs_review' && row;
    });
    expect(invoice).toMatchObject({
      extractionStatus: 'succeeded',
      extractionModel: 'stub',
      extractionPromptVersion: 'stub',
      extractionRaw: {},
      extractionError: null,
      extractedAt: expect.any(Date),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const input = spy.mock.calls[0]?.[0];
    expect(input?.pdf.equals(asmPdf.data)).toBe(true);
    expect(input).toMatchObject({
      fileName: 'asm.pdf',
      email: { from: 'billing@vendor.example', subject: 'Invoice 42' },
    });

    const events = await t.prisma.invoiceEvent.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['received', 'extracted']);
    expect(events[1]).toMatchObject({
      userId: null,
      data: { model: 'stub', promptVersion: 'stub' },
    });
  });

  it('after the last of 3 failed attempts: extraction failed, needs_review, one `extraction_failed`', async () => {
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

    // pg-boss records the job itself as failed after its retries.
    const boss = await t.app.get(JobsService).ready();
    const jobs = await boss.findJobs(EXTRACT_QUEUE, { key: invoiceId });
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
    expect(await sweep.run()).toEqual([stuckId]);

    const boss = await t.app.get(JobsService).ready();
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: stuckId })).toHaveLength(1);
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: freshId })).toHaveLength(0);

    // Still stuck on the next run, but its job is queued: nothing new.
    expect(await sweep.run()).toEqual([]);
    expect(await boss.findJobs(EXTRACT_QUEUE, { key: stuckId })).toHaveLength(1);
  });

  it('ignores invoices that are not processing', async () => {
    const id = await ingestOne(t);
    await resetJobs(t);
    await t.prisma.$executeRaw`
      UPDATE invoices SET status = 'needs_review', updated_at = now() - interval '1 hour'
      WHERE id = ${id}::uuid`;
    expect(await t.app.get(RecoverySweep).run()).toEqual([]);
  });
});
