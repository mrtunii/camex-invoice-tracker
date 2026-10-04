import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type Clock,
  type ExtractedInvoice,
  type ExtractionOutputV1,
  extractedInvoiceSchema,
} from '@camex/shared';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashPassword } from '../src/auth/password.js';
import { CLOCK } from '../src/clock/clock.module.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type Env, loadRootEnvFile, parseEnv } from '../src/config/env.js';
import { ExtractionHandler } from '../src/extraction/extraction.handler.js';
import { INVOICE_EXTRACTOR, type InvoiceExtractor } from '../src/extraction/invoice-extractor.js';
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
 * Boots the app the same way main.ts does (NestFactory + configureApp), so the global
 * middleware (CORS, Origin check, webhook limits) applies as in production.
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

// ─── Evaluation (T04) ─────────────────────────────────────────────────────────

export type FixtureName = 'asm' | 'petrocas' | 'aeg';

/** Plausible sender addresses for the fixtures (as in `pnpm simulate:mailgun`). */
export const FIXTURE_SENDERS: Record<FixtureName, string> = {
  asm: 'ASM Aviation Services <accounts@asm-aviation.example>',
  petrocas: 'Petrocas <billing@petrocas-fuel.example>',
  aeg: 'AEG Fuels <ar@aegfuels.example>',
};

/** Pins "now" for business logic (Tbilisi business day `date`, mid-morning). */
export function setToday(t: TestApp, date: string): void {
  vi.spyOn(t.app.get<Clock>(CLOCK), 'now').mockReturnValue(new Date(`${date}T08:00:00Z`));
}

/** A copy of a fixture PDF with different bytes (another sha256), still a readable PDF. */
export function pdfVariant(name: FixtureName, tag: string): Buffer {
  return Buffer.concat([fixture(`${name}.pdf`), Buffer.from(`\n% variant ${tag}\n`)]);
}

/** Ingests one PDF by (simulated) Mailgun; returns the invoice id. */
export async function ingestPdf(
  t: TestApp,
  options: { pdf: Buffer; from?: string; fileName?: string },
): Promise<string> {
  const res = await postMailgun(t, {
    fields: options.from === undefined ? {} : { from: options.from },
    attachments: [
      {
        filename: options.fileName ?? 'invoice.pdf',
        contentType: 'application/pdf',
        data: options.pdf,
      },
    ],
  }).expect(200);
  return res.body.invoiceIds[0] as string;
}

/** Runs the real extraction handler once, with the extractor returning `raw`. */
export async function extractWith(
  t: TestApp,
  invoiceId: string,
  raw: ExtractionOutputV1,
): Promise<void> {
  vi.spyOn(t.app.get<InvoiceExtractor>(INVOICE_EXTRACTOR), 'extract').mockResolvedValueOnce({
    model: 'claude-sonnet-5-5',
    promptVersion: 'extract-v1',
    raw,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
  });
  await t.app.get(ExtractionHandler).handle({ data: { invoiceId }, retryCount: 0, retryLimit: 2 });
}

/** Ingests fixture `name` from its usual sender and extracts it as its golden file says. */
export async function ingestFixture(
  t: TestApp,
  name: FixtureName,
  options: { pdf?: Buffer; from?: string; wire?: Partial<ExtractionOutputV1> } = {},
): Promise<string> {
  const invoiceId = await ingestPdf(t, {
    pdf: options.pdf ?? fixture(`${name}.pdf`),
    from: options.from ?? FIXTURE_SENDERS[name],
    fileName: `${name}.pdf`,
  });
  await extractWith(t, invoiceId, {
    ...wireFromExpected(expectedExtraction(name)),
    ...options.wire,
  });
  return invoiceId;
}

export function flagCodes(flags: unknown): string[] {
  return (flags as { code: string }[]).map((flag) => flag.code);
}
