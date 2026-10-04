import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type Env, loadRootEnvFile, parseEnv } from '../src/config/env.js';
import type { User } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

/** Env for tests: the root .env, pointed at TEST_DATABASE_URL, silent logs. */
export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  loadRootEnvFile();
  return parseEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
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

export async function createUser(
  prisma: PrismaService,
  data: { email: string; name?: string; password?: string; isActive?: boolean },
): Promise<User> {
  return prisma.user.create({
    data: {
      email: data.email,
      name: data.name ?? data.email.split('@')[0] ?? 'User',
      passwordHash: await hashPassword(data.password ?? TEST_PASSWORD),
      isActive: data.isActive ?? true,
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
