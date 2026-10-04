import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_QUEUE } from '../src/extraction/extraction-queue.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import {
  type TestApp,
  createTestApp,
  createUser,
  fixture,
  login,
  resetDatabase,
  resetJobs,
} from './helpers.js';

describe('POST /api/invoices/upload', () => {
  let t: TestApp;
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    userId = (await createUser(t.prisma, { email: 'clerk@camex.aero' })).id;
    cookie = await login(t, 'clerk@camex.aero');
  });

  async function objectCount(): Promise<number> {
    const storage = t.app.get(StorageService);
    const res = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket }));
    return res.KeyCount ?? 0;
  }

  it('requires a session (401 before anything is read)', async () => {
    await t
      .http()
      .post('/api/invoices/upload')
      .attach('files', fixture('asm.pdf'), { filename: 'asm.pdf', contentType: 'application/pdf' })
      .expect(401);
    expect(await t.prisma.inboundEmail.count()).toBe(0);
  });

  it('creates a manual inbound email with one invoice per PDF and enqueues extraction', async () => {
    const res = await t
      .http()
      .post('/api/invoices/upload')
      .set('Cookie', cookie)
      .attach('files', fixture('asm.pdf'), { filename: 'asm.pdf', contentType: 'application/pdf' })
      .attach('files', fixture('petrocas.pdf'), {
        filename: 'petrocas.pdf',
        contentType: 'application/octet-stream',
      })
      .expect(201);
    expect(res.body.invoiceIds).toHaveLength(2);

    const email = await t.prisma.inboundEmail.findUniqueOrThrow({
      where: { id: res.body.inboundEmailId },
      include: { invoices: { include: { events: true } } },
    });
    expect(email).toMatchObject({
      provider: 'manual',
      messageId: null,
      subject: 'Manual upload',
      fromAddress: 'clerk@camex.aero',
      uploadedById: userId,
      bodyText: null,
      headers: null,
    });
    expect(email.invoices).toHaveLength(2);
    for (const invoice of email.invoices) {
      expect(invoice).toMatchObject({ status: 'processing', extractionStatus: 'pending' });
      expect(invoice.events).toMatchObject([
        { type: 'received', data: { source: 'manual', inboundEmailId: email.id } },
      ]);
    }

    const boss = await t.app.get(JobsService).ready();
    for (const id of res.body.invoiceIds as string[]) {
      expect(await boss.findJobs(EXTRACT_QUEUE, { key: id })).toHaveLength(1);
    }
  });

  it('rejects the whole batch when any file is not a PDF, listing the rejected names', async () => {
    const before = await objectCount();
    const res = await t
      .http()
      .post('/api/invoices/upload')
      .set('Cookie', cookie)
      .attach('files', fixture('asm.pdf'), { filename: 'asm.pdf', contentType: 'application/pdf' })
      .attach('files', Buffer.from('a,b\n1,2\n'), {
        filename: 'totals.csv',
        contentType: 'text/csv',
      })
      .attach('files', Buffer.from('nope'), {
        filename: 'renamed.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(res.body).toMatchObject({
      message: expect.stringMatching(/Only PDF files/),
      rejectedFiles: ['totals.csv', 'renamed.pdf'],
    });
    expect(await t.prisma.inboundEmail.count()).toBe(0);
    expect(await t.prisma.invoice.count()).toBe(0);
    expect(await objectCount()).toBe(before);
  });

  it('rejects an empty upload and more than 20 files', async () => {
    await t.http().post('/api/invoices/upload').set('Cookie', cookie).expect(400);

    let req = t.http().post('/api/invoices/upload').set('Cookie', cookie);
    for (let i = 0; i < 21; i++) {
      req = req.attach('files', fixture('aeg.pdf'), {
        filename: `f${i}.pdf`,
        contentType: 'application/pdf',
      });
    }
    await req.expect(400);
    expect(await t.prisma.inboundEmail.count()).toBe(0);
  });

  it('keeps 413 for a file over INBOUND_MAX_FILE_MB (the 406 rule is for the webhook only)', async () => {
    const small = await createTestApp({ env: { INBOUND_MAX_FILE_MB: '1' } });
    try {
      const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024 + 1)]);
      await small
        .http()
        .post('/api/invoices/upload')
        .set('Cookie', cookie)
        .attach('files', big, { filename: 'big.pdf', contentType: 'application/pdf' })
        .expect(413);
      expect(await t.prisma.inboundEmail.count()).toBe(0);
    } finally {
      await small.close();
    }
  });
});
