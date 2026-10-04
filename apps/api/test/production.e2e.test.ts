import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session-token.js';
import { type TestApp, createTestApp, createUser, resetDatabase, setCookies } from './helpers.js';

describe('production mode', () => {
  let t: TestApp;
  let webDist: string;

  beforeAll(async () => {
    webDist = mkdtempSync(join(tmpdir(), 'camex-web-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root">spa</div>');
    writeFileSync(join(webDist, 'assets', 'app-abc123.js'), 'console.log(1)');
    t = await createTestApp({ env: { NODE_ENV: 'production', WEB_DIST_DIR: webDist } });
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it('serves the SPA with history fallback', async () => {
    for (const path of ['/', '/invoices', '/users/some/deep/link']) {
      const res = await t.http().get(path).expect(200);
      expect(res.text).toContain('spa');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    const asset = await t.http().get('/assets/app-abc123.js').expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps /api routes on the API (JSON 404, guard still applies)', async () => {
    const res = await t.http().get('/api/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await t.http().get('/api/users').expect(401);
    await t.http().get('/api/health').expect(200);
  });

  it('sets the Secure flag on the session cookie', async () => {
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
  });
});
