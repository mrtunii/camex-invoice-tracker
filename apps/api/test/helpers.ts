import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type ExtractedInvoice,
  type ExtractionOutputV1,
  extractedInvoiceSchema,
} from '@camex/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type Env, loadRootEnvFile, parseEnv } from '../src/config/env.js';
import type { User } from '../src/generated/prisma/client.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export const TEST_SIGNING_KEY = 'test-mailgun-signing-key';

/**
 * Env for tests: the root .env, pointed at TEST_DATABASE_URL and TEST_S3_BUCKET, silent logs,
 * no bootstrap admin, and job workers off (tests that need them turn them on).
 */
export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  loadRootEnvFile();
  return parseEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    S3_BUCKET: process.env.TEST_S3_BUCKET,
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    MAILGUN_WEBHOOK_SIGNING_KEY: TEST_SIGNING_KEY,
    EXTRACTOR_PROVIDER: 'stub',
    EXTRACTION_RETRY_DELAY_SECONDS: '1',
    WORKERS_ENABLED: 'false',
    ...overrides,
  });
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  env: Env;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

@Module({})
class TestRootModule {}

/**
 * Boots the app the same way main.ts does (NestFactory, not @nestjs/testing: the testing
 * module instantiates providers before the HTTP adapter exists, which disables ServeStaticModule).
 */
export async function createTestApp(
  options: { env?: NodeJS.ProcessEnv; controllers?: Type[] } = {},
): Promise<TestApp> {
  const env = testEnv(options.env);
  const root: DynamicModule = {
    module: TestRootModule,
    imports: [AppModule.forRoot(env)],
    controllers: options.controllers ?? [],
  };
  const app = await NestFactory.create<NestExpressApplication>(root, { bufferLogs: true });
  configureApp(app, env);
  await app.init();

  return {
    app,
    env,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE invoice_events, invoices, inbound_emails, vendors, sessions, users CASCADE',
  );
}

/** Removes every pg-boss job so one test's jobs can't leak into the next. */
export async function resetJobs(t: TestApp): Promise<void> {
  await (await t.app.get(JobsService).ready()).deleteAllJobs();
}

export async function createUser(
  prisma: PrismaService,
  data: {
    email: string;
    name?: string;
    password?: string;
    isActive?: boolean;
    mustChangePassword?: boolean;
  },
): Promise<User> {
  return prisma.user.create({
    data: {
      email: data.email,
      name: data.name ?? data.email.split('@')[0] ?? 'User',
      passwordHash: await hashPassword(data.password ?? TEST_PASSWORD),
      isActive: data.isActive ?? true,
      mustChangePassword: data.mustChangePassword ?? false,
    },
  });
}

/** Set-Cookie headers of a supertest response, always as an array. */
export function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const header = res.headers['set-cookie'];
  if (Array.isArray(header)) return header.map(String);
  return typeof header === 'string' ? [header] : [];
}

/** The session cookie from a response as a `name=value` pair for the Cookie header. */
export function sessionCookieFrom(res: { headers: Record<string, unknown> }): string {
  const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error('response did not set the session cookie');
  return cookie.split(';')[0] ?? '';
}

export async function login(
  t: TestApp,
  email: string,
  password = TEST_PASSWORD,
  ip?: string,
): Promise<string> {
  let req = t.http().post('/api/auth/login').send({ email, password });
  if (ip) req = req.set('X-Forwarded-For', ip);
  const res = await req.expect(200);
  return sessionCookieFrom(res);
}

/** Polls until `check` returns a value other than undefined/false, or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

// ─── Fixtures and Mailgun ─────────────────────────────────────────────────────

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/invoices');

export function fixture(name: 'asm.pdf' | 'petrocas.pdf' | 'aeg.pdf'): Buffer {
  return readFileSync(resolve(FIXTURES, name));
}

export function mailgunSignature(key = TEST_SIGNING_KEY) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = randomBytes(25).toString('hex');
  return {
    timestamp,
    token,
    signature: createHmac('sha256', key)
      .update(timestamp + token)
      .digest('hex'),
  };
}

export interface MailgunAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * POSTs a Mailgun route-forward payload like Mailgun does: multipart with attachments,
 * urlencoded without. `fields` are added after (and override) the defaults.
 */
export function postMailgun(
  t: TestApp,
  options: {
    fields?: Record<string, string | undefined>;
    attachments?: MailgunAttachment[];
    signature?: Partial<Record<'timestamp' | 'token' | 'signature', string | undefined>>;
  } = {},
) {
  const fields: Record<string, string | undefined> = {
    recipient: 'invoices@in.camex.aero',
    sender: 'billing@vendor.example',
    from: 'Vendor Billing <Billing@Vendor.example>',
    subject: 'Invoice 42',
    'body-plain': 'Please find our invoice attached.',
    'Message-Id': `<${randomBytes(8).toString('hex')}@vendor.example>`,
    ...mailgunSignature(),
    ...options.signature,
    ...options.fields,
  };
  const defined = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const attachments = options.attachments ?? [];
  const req = t.http().post('/api/inbound/mailgun');
  if (attachments.length === 0) {
    return req.type('form').send(new URLSearchParams(defined).toString());
  }
  for (const [key, value] of defined) void req.field(key, value);
  void req.field('attachment-count', String(attachments.length));
  attachments.forEach((file, i) => {
    void req.attach(`attachment-${i + 1}`, file.data, {
      filename: file.filename,
      contentType: file.contentType,
    });
  });
  return req;
}

// ─── Extraction fixtures ──────────────────────────────────────────────────────

export function expectedExtraction(name: 'asm' | 'petrocas' | 'aeg'): ExtractedInvoice {
  return extractedInvoiceSchema.parse(
    JSON.parse(readFileSync(resolve(FIXTURES, 'expected', `${name}.json`), 'utf8')),
  );
}

/** A wire (model) output equivalent to a golden file: "" for null, strings for numbers. */
export function wireFromExpected(expected: ExtractedInvoice): ExtractionOutputV1 {
  const s = (value: string | number | null) => (value === null ? '' : String(value));
  const bank = expected.bankDetails;
  return {
    documentType: expected.documentType,
    vendorName: s(expected.vendorName),
    vendorTaxId: s(expected.vendorTaxId),
    billToName: s(expected.billToName),
    invoiceNumber: s(expected.invoiceNumber),
    invoiceDate: s(expected.invoiceDate),
    serviceDate: s(expected.serviceDate),
    dueDate: s(expected.dueDate),
    paymentTermsText: s(expected.paymentTermsText),
    paymentTermsDays: s(expected.paymentTermsDays),
    disputeWindowDays: s(expected.disputeWindowDays),
    category: expected.category,
    description: s(expected.description),
    airportIcao: s(expected.airportIcao),
    airportIata: s(expected.airportIata),
    locationText: s(expected.locationText),
    aircraftRegistration: s(expected.aircraftRegistration),
    flightNumbers: [...expected.flightNumbers],
    currency: s(expected.currency),
    subtotalAmount: s(expected.subtotalAmount),
    taxAmount: s(expected.taxAmount),
    totalAmount: s(expected.totalAmount),
    amountDue: s(expected.amountDue),
    amountDueCurrency: s(expected.amountDueCurrency),
    lineItems: expected.lineItems.map((line) => ({
      kind: line.kind,
      description: s(line.description),
      quantity: s(line.quantity),
      uom: s(line.uom),
      unitPrice: s(line.unitPrice),
      amount: s(line.amount),
    })),
    bankDetails: {
      beneficiary: s(bank?.beneficiary ?? null),
      bankName: s(bank?.bankName ?? null),
      iban: s(bank?.iban ?? null),
      accountNumber: s(bank?.accountNumber ?? null),
      swift: s(bank?.swift ?? null),
      routingNumber: s(bank?.routingNumber ?? null),
      currency: s(bank?.currency ?? null),
    },
    notes: s(expected.notes),
  };
}

/** What a model would plausibly return for asm.pdf: printed shorthand, no hyphen. */
export function asmWireOutput(): ExtractionOutputV1 {
  return {
    ...wireFromExpected(expectedExtraction('asm')),
    flightNumbers: ['CMS503/4'],
    aircraftRegistration: '4LCME',
  };
}
