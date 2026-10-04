import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type TestApp, createTestApp, createUser, resetDatabase, setCookies } from './helpers.js';

describe('production mode', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      env: { NODE_ENV: 'production', WEB_ORIGINS: 'https://camex-fin.site' },
    });
    await resetDatabase(t.prisma);
  });
  afterAll(() => t.close());

  it('serves no SPA: the web app is its own image, so non-/api paths are 404', async () => {
    for (const path of ['/', '/inbox', '/users/some/deep/link', '/assets/app-abc123.js']) {
      const res = await t.http().get(path).expect(404);
      expect(res.text).not.toContain('<div id="root">');
    }
  });

  it('keeps /api routes on the API (JSON 404, guard still applies)', async () => {
    const res = await t.http().get('/api/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await t.http().get('/api/users').expect(401);
    await t.http().get('/api/health').expect(200);
  });

  it('sets the session cookie Secure, HttpOnly, SameSite=Lax and host-only', async () => {
    await createUser(t.prisma, { email: 'admin@camex.aero' });
    const res = await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'admin@camex.aero', password: 'correct-horse-battery-staple' })
      .expect(200);
    const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // No Domain attribute: the cookie stays on the API host (SPEC §3 same-site rule).
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
