import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_RATE_LIMIT } from '../src/auth/login-rate-limiter.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
} from '../src/auth/session-token.js';
import {
  TEST_PASSWORD,
  type TestApp,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  sessionCookieFrom,
  setCookies,
} from './helpers.js';

const HOUR = 60 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'Invalid email or password';

describe('auth', () => {
  let t: TestApp;

  // A fresh app per test also gives each test a fresh in-memory login rate limiter.
  beforeEach(async () => {
    // TRUST_PROXY lets tests vary the client IP via X-Forwarded-For.
    t = await createTestApp({ env: { TRUST_PROXY: '1' } });
    await resetDatabase(t.prisma);
  });
  afterEach(() => t.close());

  describe('POST /api/auth/login', () => {
    it('logs in, sets an httpOnly SameSite=Lax cookie and stores only the token hash', async () => {
      const user = await createUser(t.prisma, { email: 'admin@camex.aero', name: 'Admin' });

      const res = await t
        .http()
        .post('/api/auth/login')
        .send({ email: 'Admin@Camex.Aero', password: TEST_PASSWORD })
        .expect(200);

      expect(res.body).toEqual({
        user: { id: user.id, email: 'admin@camex.aero', name: 'Admin', mustChangePassword: false },
      });

      const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Secure/); // only in production

      const token = sessionCookieFrom(res).split('=')[1] ?? '';
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);

      const sessions = await t.prisma.session.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.tokenHash).toBe(hashSessionToken(token));
      expect(sessions[0]?.tokenHash).not.toContain(token);
      const ttl = (sessions[0]?.expiresAt.getTime() ?? 0) - Date.now();
      expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS);

      const reloaded = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(reloaded.lastLoginAt).not.toBeNull();

      await t
        .http()
        .get('/api/auth/me')
        .set('Cookie', sessionCookieFrom(res))
        .expect(200, {
          user: {
            id: user.id,
            email: 'admin@camex.aero',
            name: 'Admin',
            mustChangePassword: false,
          },
        });
    });

    it('returns the same generic 401 for wrong password, unknown email and inactive user', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      await createUser(t.prisma, { email: 'inactive@camex.aero', isActive: false });

      const attempts = [
        { email: 'admin@camex.aero', password: 'wrong-password-123' },
        { email: 'nobody@camex.aero', password: TEST_PASSWORD },
        { email: 'inactive@camex.aero', password: TEST_PASSWORD },
      ];
      for (const body of attempts) {
        const res = await t.http().post('/api/auth/login').send(body).expect(401);
        expect(res.body.message).toBe(GENERIC_LOGIN_ERROR);
        expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
      }
      expect(await t.prisma.session.count()).toBe(0);
    });

    it('rejects malformed input with 400', async () => {
      await t.http().post('/api/auth/login').send({ email: 'admin@camex.aero' }).expect(400);
      await t.http().post('/api/auth/login').send({ email: 'nope', password: 'x' }).expect(400);
    });

    it('rate-limits failed attempts per email, across IPs', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      await createUser(t.prisma, { email: 'other@camex.aero' });

      for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailuresPerEmail; i++) {
        await t
          .http()
          .post('/api/auth/login')
          .set('X-Forwarded-For', `10.0.0.${i + 1}`)
          .send({ email: 'admin@camex.aero', password: 'wrong-password-123' })
          .expect(401);
      }

      // Locked even with the right password and a fresh IP.
      const blocked = await t
        .http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.1.1')
        .send({ email: 'admin@camex.aero', password: TEST_PASSWORD })
        .expect(429);
      expect(blocked.body.message).toBe('Too many login attempts. Try again later.');

      // Other accounts are unaffected.
      await login(t, 'other@camex.aero', TEST_PASSWORD, '10.0.0.1');
    });

    it('rate-limits failed attempts per IP, across emails', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });

      for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailuresPerIp; i++) {
        await t
          .http()
          .post('/api/auth/login')
          .set('X-Forwarded-For', '192.0.2.10')
          .send({ email: `guess${i}@camex.aero`, password: 'wrong-password-123' })
          .expect(401);
      }

      await t
        .http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', '192.0.2.10')
        .send({ email: 'admin@camex.aero', password: TEST_PASSWORD })
        .expect(429);

      // Same account from another IP still works.
      await login(t, 'admin@camex.aero', TEST_PASSWORD, '192.0.2.11');
    });
  });

  describe('sessions', () => {
    async function insertSession(userId: string, data: { expiresAt: Date; lastSeenAt: Date }) {
      const token = generateSessionToken();
      const session = await t.prisma.session.create({
        data: { userId, tokenHash: hashSessionToken(token), ...data },
      });
      return { session, cookie: `${SESSION_COOKIE}=${token}` };
    }

    it('rejects an expired session and deletes it', async () => {
      const user = await createUser(t.prisma, { email: 'admin@camex.aero' });
      const { session, cookie } = await insertSession(user.id, {
        expiresAt: new Date(Date.now() - 1000),
        lastSeenAt: new Date(Date.now() - 15 * 24 * HOUR),
      });

      const res = await t.http().get('/api/auth/me').set('Cookie', cookie).expect(401);
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
      expect(await t.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    });

    it('extends the session on use, writing at most once per hour', async () => {
      const user = await createUser(t.prisma, { email: 'admin@camex.aero' });

      // Last seen 2h ago → extended to now + 14d, cookie re-issued.
      const stale = await insertSession(user.id, {
        expiresAt: new Date(Date.now() + 24 * HOUR),
        lastSeenAt: new Date(Date.now() - 2 * HOUR),
      });
      const res = await t.http().get('/api/auth/me').set('Cookie', stale.cookie).expect(200);
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
      const extended = await t.prisma.session.findUniqueOrThrow({
        where: { id: stale.session.id },
      });
      expect(Date.now() - extended.lastSeenAt.getTime()).toBeLessThan(60_000);
      expect(extended.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);

      // Last seen 10 min ago → no write, no cookie.
      const fresh = await insertSession(user.id, {
        expiresAt: new Date(Date.now() + 24 * HOUR),
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      const res2 = await t.http().get('/api/auth/me').set('Cookie', fresh.cookie).expect(200);
      expect(setCookies(res2)).toHaveLength(0);
      const untouched = await t.prisma.session.findUniqueOrThrow({
        where: { id: fresh.session.id },
      });
      expect(untouched.lastSeenAt).toEqual(fresh.session.lastSeenAt);
      expect(untouched.expiresAt).toEqual(fresh.session.expiresAt);
    });

    it('logout invalidates the session', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      const cookie = await login(t, 'admin@camex.aero');
      expect(await t.prisma.session.count()).toBe(1);

      const res = await t.http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
      expect(setCookies(res).some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);

      expect(await t.prisma.session.count()).toBe(0);
      await t.http().get('/api/auth/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('requires the current password', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      const cookie = await login(t, 'admin@camex.aero');
      const res = await t
        .http()
        .post('/api/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' })
        .expect(400);
      expect(res.body.message).toBe('Current password is incorrect');
    });

    it('changes the password and signs out other sessions only', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      const current = await login(t, 'admin@camex.aero');
      const other = await login(t, 'admin@camex.aero');

      await t
        .http()
        .post('/api/auth/change-password')
        .set('Cookie', current)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
        .expect(204);

      await t.http().get('/api/auth/me').set('Cookie', current).expect(200);
      await t.http().get('/api/auth/me').set('Cookie', other).expect(401);
      await t
        .http()
        .post('/api/auth/login')
        .send({ email: 'admin@camex.aero', password: TEST_PASSWORD })
        .expect(401);
      await login(t, 'admin@camex.aero', 'a-brand-new-password');
    });

    it('enforces the password policy', async () => {
      await createUser(t.prisma, { email: 'admin@camex.aero' });
      const cookie = await login(t, 'admin@camex.aero');
      await t
        .http()
        .post('/api/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' })
        .expect(400);
    });
  });
});
