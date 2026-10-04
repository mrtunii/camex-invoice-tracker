import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  createTestApp,
  createUser,
  fixture,
  login,
  postMailgun,
  resetDatabase,
  resetJobs,
} from './helpers.js';

const asmPdf = {
  filename: 'SI-000218719.pdf',
  contentType: 'application/pdf',
  data: fixture('asm.pdf'),
};

describe('inbox and invoice files', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await resetJobs(t);
    await createUser(t.prisma, { email: 'clerk@camex.aero' });
    cookie = await login(t, 'clerk@camex.aero');
  });

  it('lists emails newest first with attachments (incl. ignored) and invoices, paginated', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await postMailgun(t, {
        fields: { subject: `Email ${i}` },
        attachments:
          i === 1
            ? [
                asmPdf,
                { filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from('hi') },
              ]
            : [],
      }).expect(200);
      ids.push(res.body.inboundEmailId as string);
    }

    const page1 = await t.http().get('/api/inbox?limit=2').set('Cookie', cookie).expect(200);
    expect(page1.body.items.map((e: { subject: string }) => e.subject)).toEqual([
      'Email 2',
      'Email 1',
    ]);
    expect(page1.body.nextCursor).toBe(ids[1]);

    const withInvoice = page1.body.items[1];
    expect(withInvoice).toEqual({
      id: ids[1],
      provider: 'mailgun',
      receivedAt: expect.any(String),
      fromAddress: 'billing@vendor.example',
      subject: 'Email 1',
      attachments: [
        {
          filename: 'SI-000218719.pdf',
          contentType: 'application/pdf',
          size: asmPdf.data.length,
          processed: true,
        },
        { filename: 'notes.txt', contentType: 'text/plain', size: 2, processed: false },
      ],
      invoices: [
        {
          id: expect.any(String),
          status: 'processing',
          extractionStatus: 'pending',
          fileName: 'SI-000218719.pdf',
          flags: [],
        },
      ],
    });
    // List items don't carry the body or headers.
    expect(withInvoice).not.toHaveProperty('bodyText');

    const page2 = await t
      .http()
      .get(`/api/inbox?limit=2&cursor=${page1.body.nextCursor as string}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(page2.body.items.map((e: { subject: string }) => e.subject)).toEqual(['Email 0']);
    expect(page2.body.nextCursor).toBeNull();

    await t.http().get('/api/inbox?limit=0').set('Cookie', cookie).expect(400);
    await t.http().get('/api/inbox?cursor=nope').set('Cookie', cookie).expect(400);
  });

  it('returns one email with its body and headers', async () => {
    const headers = [
      ['From', 'Vendor <billing@vendor.example>'],
      ['Subject', 'Invoice 42'],
    ];
    const res = await postMailgun(t, {
      fields: { 'body-plain': 'Hello finance', 'message-headers': JSON.stringify(headers) },
    }).expect(200);

    const detail = await t
      .http()
      .get(`/api/inbox/${res.body.inboundEmailId as string}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body).toMatchObject({
      id: res.body.inboundEmailId,
      subject: 'Invoice 42',
      bodyText: 'Hello finance',
      headers,
      invoices: [],
    });

    await t
      .http()
      .get('/api/inbox/00000000-0000-4000-8000-000000000000')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('streams the original PDF byte for byte, inline with its filename, never cached', async () => {
    const res = await postMailgun(t, {
      attachments: [{ ...asmPdf, filename: 'Rechnung ü "1".pdf' }],
    }).expect(200);
    const invoiceId = res.body.invoiceIds[0] as string;

    await t.http().get(`/api/invoices/${invoiceId}/file`).expect(401);

    const file = await t
      .http()
      .get(`/api/invoices/${invoiceId}/file`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          callback(null, Buffer.concat(chunks));
        });
      })
      .expect(200);

    expect(Buffer.isBuffer(file.body) && file.body.equals(asmPdf.data)).toBe(true);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-length']).toBe(String(asmPdf.data.length));
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['content-disposition']).toBe(
      `inline; filename="Rechnung _ _1_.pdf"; filename*=UTF-8''Rechnung%20%C3%BC%20%221%22.pdf`,
    );

    await t
      .http()
      .get('/api/invoices/00000000-0000-4000-8000-000000000000/file')
      .set('Cookie', cookie)
      .expect(404);
  });
});
