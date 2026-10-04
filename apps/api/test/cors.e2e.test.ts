import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  type TestApp,
  createTestApp,
  createUser,
  fixture,
  login,
  postMailgun,
  resetDatabase,
  setCookies,
} from './helpers.js';

const WEB = 'https://camex-fin.site';
const LOCAL_WEB = 'http://localhost:8090';
const FOREIGN = 'https://evil.example';

/** Every Access-Control-* response header. */
function corsHeaders(res: { headers: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(res.headers).filter(([name]) => name.startsWith('access-control-')),
  );
}

describe('web access: CORS and the Origin check', () => {
  let t: TestApp;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { WEB_ORIGINS: `${WEB},${LOCAL_WEB}` } });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    userId = (await createUser(t.prisma, { email: 'clerk@camex.aero' })).id;
    cookie = await login(t, 'clerk@camex.aero');
  });

  describe('CORS', () => {
    it('an allowed origin gets the credentialed CORS headers', async () => {
      for (const origin of [WEB, LOCAL_WEB]) {
        const res = await t
          .http()
          .get('/api/auth/me')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .expect(200);
        expect(corsHeaders(res)).toEqual({
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
        });
        expect(res.headers.vary).toMatch(/Origin/);
      }
    });

    it('another origin gets no CORS headers at all', async () => {
      const res = await t
        .http()
        .get('/api/auth/me')
        .set('Origin', FOREIGN)
        .set('Cookie', cookie)
        .expect(200);
      expect(corsHeaders(res)).toEqual({});
    });

    it('preflight from an allowed origin: 204 with methods, Content-Type and max-age 600', async () => {
      const res = await t
        .http()
        .options(`/api/users/${userId}`)
        .set('Origin', WEB)
        .set('Access-Control-Request-Method', 'PATCH')
        .set('Access-Control-Request-Headers', 'content-type')
        .expect(204);
      expect(corsHeaders(res)).toEqual({
        'access-control-allow-origin': WEB,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE',
        'access-control-allow-headers': 'Content-Type',
        'access-control-max-age': '600',
      });
    });

    it('preflight from another origin gets no CORS headers, so the browser never sends it', async () => {
      const res = await t
        .http()
        .options('/api/auth/login')
        .set('Origin', FOREIGN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(corsHeaders(res)).toEqual({});
    });

    it('/api/inbound/* gets no CORS headers, even from an allowed origin', async () => {
      const res = await t
        .http()
        .options('/api/inbound/mailgun')
        .set('Origin', WEB)
        .set('Access-Control-Request-Method', 'POST');
      expect(corsHeaders(res)).toEqual({});
    });
  });

  describe('Origin check (POST, PATCH, DELETE)', () => {
    it('a foreign Origin gets 403 before the route runs', async () => {
      const login = await t
        .http()
        .post('/api/auth/login')
        .set('Origin', FOREIGN)
        .send({ email: 'clerk@camex.aero', password: TEST_PASSWORD })
        .expect(403);
      expect(login.body).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Origin not allowed',
      });
      expect(setCookies(login)).toEqual([]);

      await t
        .http()
        .patch(`/api/users/${userId}`)
        .set('Origin', FOREIGN)
        .set('Cookie', cookie)
        .send({ name: 'Renamed' })
        .expect(403);
      await t
        .http()
        .delete('/api/vendors/00000000-0000-4000-8000-000000000000/bank-accounts/x')
        .set('Origin', FOREIGN)
        .set('Cookie', cookie)
        .expect(403);
      // A sandboxed frame or a redirect sends "null"; routes match case-insensitively.
      await t.http().post('/api/auth/logout').set('Origin', 'null').expect(403);
      await t.http().post('/API/Auth/Logout').set('Origin', FOREIGN).expect(403);

      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).name).not.toBe(
        'Renamed',
      );
    });

    it('an allowed Origin, or none (curl, scripts), is handled normally', async () => {
      const fromWeb = await t
        .http()
        .post('/api/auth/login')
        .set('Origin', WEB)
        .send({ email: 'clerk@camex.aero', password: TEST_PASSWORD })
        .expect(200);
      expect(fromWeb.headers['access-control-allow-origin']).toBe(WEB);

      await t
        .http()
        .patch(`/api/users/${userId}`)
        .set('Origin', LOCAL_WEB)
        .set('Cookie', cookie)
        .send({ name: 'Renamed' })
        .expect(200);
      await t
        .http()
        .post('/api/auth/login')
        .send({ email: 'clerk@camex.aero', password: TEST_PASSWORD })
        .expect(200);
    });

    it('GET is not blocked (without CORS headers a foreign page cannot read the response)', async () => {
      await t.http().get('/api/auth/me').set('Origin', FOREIGN).set('Cookie', cookie).expect(200);
    });

    it('the Mailgun webhook is unaffected by any Origin', async () => {
      const res = await postMailgun(t, {
        attachments: [
          { filename: 'asm.pdf', contentType: 'application/pdf', data: fixture('asm.pdf') },
        ],
      })
        .set('Origin', FOREIGN)
        .expect(200);
      expect(res.body.invoiceIds).toHaveLength(1);
      expect(corsHeaders(res)).toEqual({});
    });
  });
});
