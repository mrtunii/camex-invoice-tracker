import { type Clock, invoiceDetailSchema } from '@camex/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK } from '../src/clock/clock.module.js';
import { ExtractionHandler } from '../src/extraction/extraction.handler.js';
import { INVOICE_EXTRACTOR, type InvoiceExtractor } from '../src/extraction/invoice-extractor.js';
import {
  type TestApp,
  asmWireOutput,
  createTestApp,
  createUser,
  expectedExtraction,
  fixture,
  login,
  postMailgun,
  resetDatabase,
  resetJobs,
} from './helpers.js';

describe('GET /api/invoices/:id', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp(); // workers off: the test runs the handler itself
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    await createUser(t.prisma, { email: 'clerk@camex.aero' });
    cookie = await login(t, 'clerk@camex.aero');
    // Business day 2026-10-02 in Tbilisi, so date-based flags are stable.
    vi.spyOn(t.app.get<Clock>(CLOCK), 'now').mockReturnValue(new Date('2026-10-02T08:00:00Z'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Ingests asm.pdf and extracts it with a fake model output. */
  async function extractedAsm(): Promise<{ invoiceId: string; inboundEmailId: string }> {
    const res = await postMailgun(t, {
      attachments: [
        { filename: 'asm.pdf', contentType: 'application/pdf', data: fixture('asm.pdf') },
      ],
    }).expect(200);
    const invoiceId = res.body.invoiceIds[0] as string;
    vi.spyOn(t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR), 'extract').mockResolvedValue({
      model: 'claude-sonnet-5-5',
      promptVersion: 'extract-v1',
      raw: asmWireOutput(),
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    });
    await t.app
      .get(ExtractionHandler)
      .handle({ data: { invoiceId }, retryCount: 0, retryLimit: 2 });
    return { invoiceId, inboundEmailId: res.body.inboundEmailId as string };
  }

  it('requires a session', async () => {
    const { invoiceId } = await extractedAsm();
    const res = await t.http().get(`/api/invoices/${invoiceId}`).expect(401);
    expect(res.body.message).toBe('Not authenticated');
  });

  it('returns the invoice in camelCase with decimal strings and calendar dates, without the raw output', async () => {
    const { invoiceId, inboundEmailId } = await extractedAsm();
    const res = await t.http().get(`/api/invoices/${invoiceId}`).set('Cookie', cookie).expect(200);

    // Exactly the DTO's fields: nothing internal (raw output, storage key) leaks.
    expect(invoiceDetailSchema.strict().parse(res.body)).toEqual(res.body);
    expect(res.body).not.toHaveProperty('extractionRaw');
    expect(res.body).not.toHaveProperty('fileKey');

    const { bankDetails, lineItems, ...golden } = expectedExtraction('asm');
    expect(res.body).toMatchObject({
      ...golden,
      // numeric(18,4) columns come back without trailing zeros
      taxAmount: '0',
      id: invoiceId,
      inboundEmailId,
      fileName: 'asm.pdf',
      status: 'needs_review',
      extractionStatus: 'succeeded',
      extractionError: null,
      extractionModel: 'claude-sonnet-5-5',
      extractionPromptVersion: 'extract-v1',
      extractedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      vendorId: null,
      vendor: null,
      dueDateSource: 'printed',
      disputeDeadline: '2026-09-30',
      flags: [
        {
          code: 'DISPUTE_SOON',
          severity: 'warning',
          field: 'disputeDeadline',
          message: 'Dispute window ended 2026-09-30',
        },
        {
          code: 'NEW_VENDOR',
          severity: 'info',
          field: 'vendorName',
          message: 'No vendor matched: link an existing vendor or create one',
        },
      ],
    });
    expect(res.body.invoiceDate).toBe('2026-09-16');
    expect(res.body.totalAmount).toBe('15617.79');
    expect(res.body.lineItems).toEqual(lineItems);
    expect(res.body.bankDetails).toEqual(bankDetails);
  });

  it('shows a failed extraction with its error and empty fields', async () => {
    const res = await postMailgun(t, {
      attachments: [
        { filename: 'x.pdf', contentType: 'application/pdf', data: fixture('aeg.pdf') },
      ],
    }).expect(200);
    const invoiceId = res.body.invoiceIds[0] as string;
    await t.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'needs_review', extractionStatus: 'failed', extractionError: 'boom' },
    });
    const detail = await t
      .http()
      .get(`/api/invoices/${invoiceId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body).toMatchObject({
      extractionStatus: 'failed',
      extractionError: 'boom',
      documentType: null,
      category: null,
      lineItems: [],
      bankDetails: null,
      totalAmount: null,
    });
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    await t
      .http()
      .get('/api/invoices/00000000-0000-0000-0000-000000000000')
      .set('Cookie', cookie)
      .expect(404);
    await t.http().get('/api/invoices/not-a-uuid').set('Cookie', cookie).expect(400);
  });
});
