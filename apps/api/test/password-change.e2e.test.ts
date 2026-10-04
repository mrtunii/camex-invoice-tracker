import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import {
  TEST_PASSWORD,
  type TestApp,
  createTestApp,
  createUser,
  login,
  resetDatabase,
} from './helpers.js';

const NEW_PASSWORD = 'my-own-new-password';
const TEMP_PASSWORD = 'temporary-password-1';

describe('must_change_password', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.prisma));

  it('allows only me, change-password and logout until the password is changed', async () => {
    await createUser(t.prisma, { email: 'temp@camex.aero', mustChangePassword: true });
    const cookie = await login(t, 'temp@camex.aero');

    const me = await t.http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);

    for (const [method, path] of [
      ['get', '/api/users'],
      ['get', '/api/inbox'],
      ['post', '/api/invoices/upload'],
    ] as const) {
      const res = await t.http()[method](path).set('Cookie', cookie).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
    }

    // Keeping the temporary password is not a change.
    const same = await t
      .http()
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
      .expect(400);
    expect(same.body.issues).toEqual([{ path: 'newPassword', message: expect.any(String) }]);

    await t
      .http()
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);

    await t.http().get('/api/users').set('Cookie', cookie).expect(200);
    const after = await t.http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(after.body.user.mustChangePassword).toBe(false);
  });

  it('lets a flagged user sign out', async () => {
    await createUser(t.prisma, { email: 'temp@camex.aero', mustChangePassword: true });
    const cookie = await login(t, 'temp@camex.aero');
    await t.http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await t.http().get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('flags users created by another admin', async () => {
    await createUser(t.prisma, { email: 'admin@camex.aero' });
    const adminCookie = await login(t, 'admin@camex.aero');
    const res = await t
      .http()
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ email: 'new@camex.aero', name: 'New', password: 'initial-password-1' })
      .expect(201);
    expect(res.body.mustChangePassword).toBe(true);

    const newCookie = await login(t, 'new@camex.aero', 'initial-password-1');
    await t.http().get('/api/users').set('Cookie', newCookie).expect(403);
  });
});

describe('POST /api/users/:id/reset-password', () => {
  let t: TestApp;
  let adminId: string;
  let adminCookie: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    adminId = (await createUser(t.prisma, { email: 'admin@camex.aero' })).id;
    adminCookie = await login(t, 'admin@camex.aero');
  });

  it("sets a temporary password, revokes the target's sessions and flags them", async () => {
    const target = await createUser(t.prisma, { email: 'target@camex.aero' });
    const targetCookie1 = await login(t, 'target@camex.aero');
    const targetCookie2 = await login(t, 'target@camex.aero');

    const res = await t
      .http()
      .post(`/api/users/${target.id}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ newPassword: TEMP_PASSWORD })
      .expect(200);
    expect(res.body).toMatchObject({ id: target.id, mustChangePassword: true, isActive: true });

    expect(await t.prisma.session.count({ where: { userId: target.id } })).toBe(0);
    await t.http().get('/api/auth/me').set('Cookie', targetCookie1).expect(401);
    await t.http().get('/api/auth/me').set('Cookie', targetCookie2).expect(401);

    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.mustChangePassword).toBe(true);
    expect(await verifyPassword(row.passwordHash, TEMP_PASSWORD)).toBe(true);

    // The old password is gone; the temporary one works but only to change it.
    await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'target@camex.aero', password: TEST_PASSWORD })
      .expect(401);
    const tempCookie = await login(t, 'target@camex.aero', TEMP_PASSWORD);
    await t.http().get('/api/users').set('Cookie', tempCookie).expect(403);

    // The admin's own session is untouched.
    await t.http().get('/api/users').set('Cookie', adminCookie).expect(200);
  });

  it('rejects resetting yourself', async () => {
    const res = await t
      .http()
      .post(`/api/users/${adminId}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ newPassword: TEMP_PASSWORD })
      .expect(400);
    expect(res.body.message).toMatch(/Change password/);

    const me = await t.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(me.mustChangePassword).toBe(false);
    expect(await verifyPassword(me.passwordHash, TEST_PASSWORD)).toBe(true);
    await t.http().get('/api/auth/me').set('Cookie', adminCookie).expect(200);
  });

  it('validates input and 404s an unknown user', async () => {
    const target = await createUser(t.prisma, { email: 'target@camex.aero' });
    await t
      .http()
      .post(`/api/users/${target.id}/reset-password`)
      .set('Cookie', adminCookie)
      .send({ newPassword: 'short' })
      .expect(400);
    await t
      .http()
      .post('/api/users/00000000-0000-4000-8000-000000000000/reset-password')
      .set('Cookie', adminCookie)
      .send({ newPassword: TEMP_PASSWORD })
      .expect(404);
  });
});
