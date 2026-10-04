import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { dashboardSchema, invoiceListResponseSchema } from '@camex/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  createTestApp,
  createUser,
  flagCodes,
  login,
  resetDatabase,
} from './helpers.js';

const run = promisify(execFile);
const apiRoot = resolve(import.meta.dirname, '..');

/** Runs the real CLI (same entry point as `pnpm seed:demo`) against the test database and bucket. */
async function seedDemo(env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', 'src/cli/seed-demo.ts'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        S3_BUCKET: process.env.TEST_S3_BUCKET,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('pnpm seed:demo', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.prisma));

  it('refuses to run with NODE_ENV=production', async () => {
    const result = await seedDemo({ NODE_ENV: 'production' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/development only: refusing to run with NODE_ENV=production/);
    expect(await t.prisma.invoice.count()).toBe(0);
  });

  it('fills an empty database that the dashboard and lists can show, and only once', async () => {
    const user = await createUser(t.prisma, { email: 'clerk@camex.aero' });
    const result = await seedDemo();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /8 vendors, 28 invoices: 4 to review, 6 to pay, 17 paid, 1 rejected/,
    );

    const invoices = await t.prisma.invoice.findMany({
      select: {
        status: true,
        fileSha256: true,
        approvedById: true,
        paidAt: true,
        paymentReference: true,
        rejectionReason: true,
        flags: true,
      },
    });
    expect(invoices).toHaveLength(28);
    // Nothing left for the extractor, and no DUPLICATE_FILE: every PDF differs.
    expect(invoices.some((i) => i.status === 'processing')).toBe(false);
    expect(new Set(invoices.map((i) => i.fileSha256)).size).toBe(28);
    expect(invoices.flatMap((i) => flagCodes(i.flags))).not.toContain('DUPLICATE_FILE');
    for (const invoice of invoices.filter((i) => i.status === 'paid')) {
      expect(invoice).toMatchObject({ approvedById: user.id, paidAt: expect.any(Date) });
      expect(invoice.paymentReference).not.toBeNull();
    }
    expect(invoices.find((i) => i.status === 'rejected')?.rejectionReason).toBe('not_invoice');

    const cookie = await login(t, 'clerk@camex.aero');
    const get = (path: string) => t.http().get(path).set('Cookie', cookie).expect(200);

    const dashboard = dashboardSchema.parse((await get('/api/dashboard')).body);
    expect(dashboard.currency).toBe('USD');
    expect(dashboard.currencies).toEqual(['USD', 'GEL']);
    expect(dashboard.attention).toMatchObject({
      toReview: { count: 4 },
      toPay: { count: 6 },
      disputeSoonCount: 1,
      overdueCount: 3,
      dueSoonCount: 2,
      extractionFailedCount: 1,
    });
    expect(dashboard.attention.toReview.items.map((i) => i.errorMessage)).toContain(
      'Due date is missing',
    );
    expect(dashboard.trend).toHaveLength(12);
    expect(dashboard.trend.filter((m) => m.invoicedCount > 0).length).toBeGreaterThan(6);
    expect(dashboard.trend.filter((m) => m.paidCount > 0).length).toBeGreaterThan(6);

    const unpaid = invoiceListResponseSchema.parse((await get('/api/invoices?status=unpaid')).body);
    expect(unpaid.total).toBe(6);
    expect(unpaid.totals.map((total) => total.currency)).toEqual(['GEL', 'USD']);

    // Each invoice's PDF is in the bucket.
    const file = await t
      .http()
      .get(`/api/invoices/${unpaid.items[0]?.id ?? ''}/file`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((file.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // A second run refuses: the database is no longer empty, and nothing is added.
    const again = await seedDemo();
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already has 28 invoice\(s\) and 8 vendor\(s\)/);
    expect(await t.prisma.invoice.count()).toBe(28);
  });
});
