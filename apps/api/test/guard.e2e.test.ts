import { Controller, Get } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Public } from '../src/auth/public.decorator.js';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type TestApp, createTestApp, createUser, login, resetDatabase } from './helpers.js';

/** Test-only routes to exercise the guard independently of real endpoints. */
@Controller('probe')
class ProbeController {
  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }

  @Get('private')
  closed() {
    return { ok: true };
  }
}

@Public()
@Controller('probe-public-class')
class PublicClassController {
  @Get()
  open() {
    return { ok: true };
  }
}

describe('global session guard', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [ProbeController, PublicClassController] });
  });
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.prisma));

  it.each([
    ['get', '/api/auth/me'],
    ['post', '/api/auth/logout'],
    ['post', '/api/auth/change-password'],
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['patch', '/api/users/00000000-0000-0000-0000-000000000000'],
    ['post', '/api/users/00000000-0000-0000-0000-000000000000/reset-password'],
    ['get', '/api/inbox'],
    ['get', '/api/inbox/00000000-0000-0000-0000-000000000000'],
    ['post', '/api/invoices/upload'],
    ['get', '/api/invoices/00000000-0000-0000-0000-000000000000'],
    ['get', '/api/invoices/00000000-0000-0000-0000-000000000000/file'],
    ['post', '/api/invoices/00000000-0000-0000-0000-000000000000/vendor'],
    ['post', '/api/invoices/00000000-0000-0000-0000-000000000000/trust-bank-details'],
    ['get', '/api/vendors'],
    ['post', '/api/vendors'],
    ['get', '/api/vendors/00000000-0000-0000-0000-000000000000'],
    ['patch', '/api/vendors/00000000-0000-0000-0000-000000000000'],
    [
      'delete',
      '/api/vendors/00000000-0000-0000-0000-000000000000/bank-accounts/00000000-0000-0000-0000-000000000000',
    ],
    ['get', '/api/probe/private'],
  ] as const)('blocks unauthenticated %s %s with 401', async (method, path) => {
    const res = await t.http()[method](path).send({}).expect(401);
    expect(res.body.message).toBe('Not authenticated');
  });

  it('blocks an unknown session token', async () => {
    await t
      .http()
      .get('/api/users')
      .set('Cookie', `${SESSION_COOKIE}=not-a-real-token`)
      .expect(401);
  });

  it('lets @Public routes through without a session', async () => {
    await t.http().get('/api/health').expect(200, { status: 'ok', db: 'ok', storage: 'ok' });
    await t.http().get('/api/probe/public').expect(200, { ok: true });
    await t.http().get('/api/probe-public-class').expect(200, { ok: true });
    // Login is public: an unauthenticated call reaches the handler (credential error, not guard error).
    const res = await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'nobody@camex.aero', password: 'whatever-password' })
      .expect(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('lets authenticated requests through', async () => {
    await createUser(t.prisma, { email: 'admin@camex.aero' });
    const cookie = await login(t, 'admin@camex.aero');
    await t.http().get('/api/probe/private').set('Cookie', cookie).expect(200, { ok: true });
  });
});
