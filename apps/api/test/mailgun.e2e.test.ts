import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import {
  type MockInstance,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { EXTRACT_QUEUE } from '../src/extraction/extraction-queue.js';
import { sha256Hex } from '../src/ingestion/files.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import {
  type TestApp,
  createTestApp,
  fixture,
  mailgunSignature,
  postMailgun,
  resetDatabase,
  resetJobs,
} from './helpers.js';

const pdf = (filename = 'invoice.pdf', data = fixture('asm.pdf')) => ({
  filename,
  contentType: 'application/pdf',
  data,
});

describe('POST /api/inbound/mailgun', () => {
  let t: TestApp;
  let storage: StorageService;

  beforeAll(async () => {
    t = await createTestApp();
    storage = t.app.get(StorageService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
  });

  async function objectCount(): Promise<number> {
    const res = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket }));
    return res.KeyCount ?? 0;
  }

  async function findJobs(invoiceId: string) {
    const boss = await t.app.get(JobsService).ready();
    return boss.findJobs<{ invoiceId: string }>(EXTRACT_QUEUE, { key: invoiceId });
  }

  describe('signature', () => {
    it('accepts a valid signature', async () => {
      await postMailgun(t, { attachments: [pdf()] }).expect(200);
      expect(await t.prisma.inboundEmail.count()).toBe(1);
    });

    it.each([
      ['an invalid signature', { signature: 'f'.repeat(64) }],
      ['a signature of the wrong length', { signature: 'abc' }],
      ['a signature made with another key', mailgunSignature('some-other-key')],
      ['a missing signature', { signature: undefined }],
      ['a missing token', { token: undefined }],
      ['a missing timestamp', { timestamp: undefined }],
    ])('rejects %s with 401 and stores nothing', async (_case, signature) => {
      const before = await objectCount();
      const res = await postMailgun(t, { signature, attachments: [pdf()] }).expect(401);
      expect(res.body.message).toBe('Invalid signature');
      expect(await t.prisma.inboundEmail.count()).toBe(0);
      expect(await t.prisma.invoice.count()).toBe(0);
      expect(await objectCount()).toBe(before);
    });

    it('rejects a token signed with a different timestamp', async () => {
      const signed = mailgunSignature();
      await postMailgun(t, {
        signature: { ...signed, timestamp: String(Number(signed.timestamp) + 1) },
      }).expect(401);
    });
  });

  it('stores the email, its PDFs and invoices, and enqueues one job per invoice', async () => {
    const asm = fixture('asm.pdf');
    const aeg = fixture('aeg.pdf');
    const res = await postMailgun(t, {
      fields: {
        'Message-Id': '<inv-1@asm.example>',
        from: '"ASM Aviation Services" <Accounts@ASM-Aviation.example>',
        sender: 'bounces@asm-aviation.example',
        subject: 'Invoice SI-000218719',
        'body-plain': 'Body text',
        'message-headers': JSON.stringify([
          ['Message-Id', '<inv-1@asm.example>'],
          ['Subject', 'Invoice SI-000218719'],
        ]),
      },
      attachments: [
        pdf('SI-000218719.pdf', asm),
        {
          filename: 'logo.png',
          contentType: 'image/png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
        },
        pdf('AEG-3110713.PDF', aeg),
      ],
    }).expect(200);

    const { inboundEmailId, invoiceIds } = res.body as {
      inboundEmailId: string;
      invoiceIds: string[];
    };
    expect(invoiceIds).toHaveLength(2);

    const email = await t.prisma.inboundEmail.findUniqueOrThrow({
      where: { id: inboundEmailId },
      include: { invoices: { include: { events: true }, orderBy: { fileName: 'desc' } } },
    });
    expect(email).toMatchObject({
      provider: 'mailgun',
      messageId: '<inv-1@asm.example>',
      fromAddress: 'accounts@asm-aviation.example',
      sender: 'bounces@asm-aviation.example',
      recipient: 'invoices@in.camex.aero',
      subject: 'Invoice SI-000218719',
      bodyText: 'Body text',
      headers: [
        ['Message-Id', '<inv-1@asm.example>'],
        ['Subject', 'Invoice SI-000218719'],
      ],
      uploadedById: null,
      attachments: [
        {
          filename: 'SI-000218719.pdf',
          content_type: 'application/pdf',
          size: asm.length,
          processed: true,
        },
        { filename: 'logo.png', content_type: 'image/png', size: 6, processed: false },
        {
          filename: 'AEG-3110713.PDF',
          content_type: 'application/pdf',
          size: aeg.length,
          processed: true,
        },
      ],
    });

    const [asmInvoice, aegInvoice] = email.invoices;
    for (const [invoice, bytes, name] of [
      [asmInvoice, asm, 'SI-000218719.pdf'],
      [aegInvoice, aeg, 'AEG-3110713.PDF'],
    ] as const) {
      expect(invoice).toMatchObject({
        fileName: name,
        fileSha256: sha256Hex(bytes),
        fileSize: bytes.length,
        pageCount: expect.any(Number),
        status: 'processing',
        extractionStatus: 'pending',
      });
      expect(invoice?.fileKey).toMatch(
        new RegExp(`^invoices/\\d{4}/\\d{2}/${invoice?.id ?? ''}\\.pdf$`),
      );
      expect(invoice?.events).toMatchObject([
        { type: 'received', userId: null, data: { source: 'mailgun', inboundEmailId } },
      ]);

      // Same bytes in the bucket.
      const stored = await buffer(await storage.getStream(invoice?.fileKey ?? ''));
      expect(stored.equals(bytes)).toBe(true);

      const jobs = await findJobs(invoice?.id ?? '');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        state: 'created',
        data: { invoiceId: invoice?.id },
        retryLimit: 2,
        retryBackoff: true,
      });
    }
  });

  it('treats application/octet-stream named *.pdf as a PDF', async () => {
    const res = await postMailgun(t, {
      attachments: [
        { filename: 'scan.PDF', contentType: 'application/octet-stream', data: fixture('aeg.pdf') },
      ],
    }).expect(200);
    expect(res.body.invoiceIds).toHaveLength(1);
  });

  it('ignores a .pdf whose bytes are not a PDF', async () => {
    const res = await postMailgun(t, {
      attachments: [
        {
          filename: 'fake.pdf',
          contentType: 'application/pdf',
          data: Buffer.from('<html>not a pdf</html>'),
        },
      ],
    }).expect(200);
    expect(res.body.invoiceIds).toEqual([]);
    const email = await t.prisma.inboundEmail.findUniqueOrThrow({
      where: { id: res.body.inboundEmailId },
    });
    expect(email.attachments).toEqual([
      { filename: 'fake.pdf', content_type: 'application/pdf', size: 22, processed: false },
    ]);
  });

  it('ingests a PDF pdf-lib cannot parse, with a null page count', async () => {
    const res = await postMailgun(t, {
      attachments: [pdf('broken.pdf', Buffer.from('%PDF-1.7\nthis is not really a pdf'))],
    }).expect(200);
    const invoice = await t.prisma.invoice.findUniqueOrThrow({
      where: { id: res.body.invoiceIds[0] },
    });
    expect(invoice.pageCount).toBeNull();
  });

  it('stores an email without attachments (urlencoded, like Mailgun) with zero invoices', async () => {
    const res = await postMailgun(t, { fields: { subject: 'Statement attached?' } }).expect(200);
    expect(res.body.invoiceIds).toEqual([]);
    const email = await t.prisma.inboundEmail.findUniqueOrThrow({
      where: { id: res.body.inboundEmailId },
    });
    expect(email).toMatchObject({ subject: 'Statement attached?', attachments: [] });
    expect(await t.prisma.invoice.count()).toBe(0);
  });

  it('processes the same Message-Id only once', async () => {
    const fields = { 'Message-Id': '<same@vendor.example>' };
    const first = await postMailgun(t, { fields, attachments: [pdf()] }).expect(200);
    const objectsAfterFirst = await objectCount();

    const second = await postMailgun(t, { fields, attachments: [pdf()] }).expect(200);
    expect(second.body).toEqual({ duplicate: true });

    expect(await t.prisma.inboundEmail.count()).toBe(1);
    expect(await t.prisma.invoice.count()).toBe(1);
    expect(await objectCount()).toBe(objectsAfterFirst);
    expect(first.body.invoiceIds).toHaveLength(1);
  });

  it('takes the Message-Id from message-headers, else falls back to mailgun:<token>', async () => {
    const fromHeaders = await postMailgun(t, {
      fields: {
        'Message-Id': undefined,
        'message-headers': JSON.stringify([['Message-ID', '<from-headers@vendor.example>']]),
      },
    }).expect(200);
    const signature = mailgunSignature();
    const fallback = await postMailgun(t, {
      fields: { 'Message-Id': undefined },
      signature,
    }).expect(200);

    const [a, b] = await Promise.all(
      [fromHeaders, fallback].map((res) =>
        t.prisma.inboundEmail.findUniqueOrThrow({
          where: { id: res.body.inboundEmailId as string },
        }),
      ),
    );
    expect(a?.messageId).toBe('<from-headers@vendor.example>');
    expect(b?.messageId).toBe(`mailgun:${signature.token}`);
  });

  it('keeps the first 20k characters of the body and UTF-8 filenames', async () => {
    const res = await postMailgun(t, {
      fields: { 'body-plain': 'x'.repeat(25_000) },
      attachments: [pdf('ინვოისი №510.pdf')],
    }).expect(200);
    const email = await t.prisma.inboundEmail.findUniqueOrThrow({
      where: { id: res.body.inboundEmailId },
      include: { invoices: true },
    });
    expect(email.bodyText).toHaveLength(20_000);
    expect(email.invoices[0]?.fileName).toBe('ინვოისი №510.pdf');
  });

  describe('limits: every violation is 406, so Mailgun stops retrying', () => {
    const MB = 1024 * 1024;
    let small: TestApp;
    let errorLog: MockInstance<Logger['error']>;

    beforeAll(async () => {
      // The file limit sits above the request cap, so only the request cap can trip here.
      small = await createTestApp({
        env: { INBOUND_MAX_REQUEST_MB: '1', INBOUND_MAX_FILE_MB: '2', INBOUND_MAX_FILES: '2' },
      });
    });
    afterAll(() => small.close());
    beforeEach(() => {
      errorLog = vi.spyOn(Logger.prototype, 'error');
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function nothingStored(before: number): Promise<void> {
      await sleep(200); // a request that slipped through would have committed by now
      expect(await t.prisma.inboundEmail.count()).toBe(0);
      expect(await t.prisma.invoice.count()).toBe(0);
      expect(await objectCount()).toBe(before);
    }

    function limitLogged(limit: string): void {
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ limit, ip: expect.any(String) }),
        'mailgun webhook rejected: limit exceeded',
      );
    }

    /**
     * Raw HTTP, because supertest always sends a complete body. Writes `body` (nothing for a
     * header-only request) and resolves with the status of the response, without finishing
     * the request. Stopping right after the cap means the server has read everything sent,
     * so it can close cleanly instead of resetting the connection under the response.
     */
    async function rawPost(headers: Record<string, string>, body?: Buffer): Promise<number> {
      const server: Server = small.app.getHttpServer();
      if (!server.listening) {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const { port } = server.address() as AddressInfo;
      return new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/inbound/mailgun',
          headers,
        });
        let answered = false;
        req.on('response', (res) => {
          answered = true;
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        });
        req.on('error', (error) => {
          if (!answered) reject(error);
        });
        if (body) req.write(body);
        else req.flushHeaders();
      });
    }

    it('rejects a Content-Length over INBOUND_MAX_REQUEST_MB without reading the body', async () => {
      const before = await objectCount();
      const status = await rawPost({
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(2 * MB),
      });
      expect(status).toBe(406);
      limitLogged('INBOUND_MAX_REQUEST_MB');
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ contentLength: String(2 * MB) }),
        expect.any(String),
      );
      await nothingStored(before);
    });

    it('stops a chunked body (no Content-Length) once it passes INBOUND_MAX_REQUEST_MB', async () => {
      const before = await objectCount();
      const head = Buffer.from(
        '--x\r\nContent-Disposition: form-data; name="attachment-1"; filename="big.pdf"\r\n' +
          'Content-Type: application/pdf\r\n\r\n%PDF-1.7\n',
      );
      const status = await rawPost(
        { 'content-type': 'multipart/form-data; boundary=x', 'transfer-encoding': 'chunked' },
        Buffer.concat([head, Buffer.alloc(MB + 64 * 1024, 0x41)]),
      );
      expect(status).toBe(406);
      limitLogged('INBOUND_MAX_REQUEST_MB');
      expect(errorLog).toHaveBeenCalledTimes(1);
      await nothingStored(before);
    });

    it('rejects a Content-Length over the cap on the urlencoded path (no attachments) too', async () => {
      const status = await rawPost({
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(2 * MB),
      });
      expect(status).toBe(406);
    });

    it('rejects a file over INBOUND_MAX_FILE_MB (was 413)', async () => {
      const before = await objectCount();
      const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(MB + 1)]);
      // Default 30 MB request cap, so the file limit is the one hit.
      const app = await createTestApp({ env: { INBOUND_MAX_FILE_MB: '1' } });
      try {
        const res = await postMailgun(app, { attachments: [pdf('big.pdf', big)] }).expect(406);
        expect(res.body.message).toBe('Message exceeds the inbound limits');
      } finally {
        await app.close();
      }
      limitLogged('INBOUND_MAX_FILE_MB');
      await nothingStored(before);
    });

    it('rejects more than INBOUND_MAX_FILES attachments', async () => {
      const before = await objectCount();
      await postMailgun(small, { attachments: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] }).expect(
        406,
      );
      limitLogged('INBOUND_MAX_FILES');
      await nothingStored(before);
    });

    it('still accepts a normal email under every limit', async () => {
      await postMailgun(small, { attachments: [pdf('a.pdf')] }).expect(200);
      expect(errorLog).not.toHaveBeenCalled();
    });
  });
});
