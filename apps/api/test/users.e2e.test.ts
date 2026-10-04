import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, createUser, login, resetDatabase } from './helpers.js';

describe('users', () => {
  let t: TestApp;
  let adminId: string;
  let adminCookie: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    adminId = (await createUser(t.prisma, { email: 'admin@camex.aero', name: 'Admin' })).id;
    adminCookie = await login(t, 'admin@camex.aero');
  });

  it('lists users without password hashes', async () => {
    const res = await t.http().get('/api/users').set('Cookie', adminCookie).expect(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toEqual({
      id: adminId,
      email: 'admin@camex.aero',
      name: 'Admin',
      isActive: true,
      mustChangePassword: false,
      lastLoginAt: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('creates a user who can then log in', async () => {
    const res = await t
      .http()
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ email: ' New.User@Camex.aero ', name: 'New User', password: 'initial-password-1' })
      .expect(201);
    expect(res.body).toMatchObject({
      email: 'new.user@camex.aero',
      name: 'New User',
      isActive: true,
    });

    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: res.body.id as string } });
    expect(row.createdById).toBe(adminId);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);

    await login(t, 'new.user@camex.aero', 'initial-password-1');
  });

  it('refuses a duplicate email with 409', async () => {
    await t
      .http()
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ email: 'ADMIN@camex.aero', name: 'Dup', password: 'initial-password-1' })
      .expect(409);
  });

  it('validates input', async () => {
    const res = await t
      .http()
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ email: 'x@camex.aero', name: '', password: 'short' })
      .expect(400);
    expect(res.body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'name',
      'password',
    ]);

    await t.http().patch(`/api/users/${adminId}`).set('Cookie', adminCookie).send({}).expect(400);
    await t
      .http()
      .patch('/api/users/not-a-uuid')
      .set('Cookie', adminCookie)
      .send({ name: 'X' })
      .expect(400);
    await t
      .http()
      .patch('/api/users/00000000-0000-4000-8000-000000000000')
      .set('Cookie', adminCookie)
      .send({ name: 'X' })
      .expect(404);
  });

  it('renames a user', async () => {
    const other = await createUser(t.prisma, { email: 'other@camex.aero' });
    const res = await t
      .http()
      .patch(`/api/users/${other.id}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(res.body).toMatchObject({ id: other.id, name: 'Renamed', isActive: true });
  });

  it('cannot deactivate yourself', async () => {
    const res = await t
      .http()
      .patch(`/api/users/${adminId}`)
      .set('Cookie', adminCookie)
      .send({ isActive: false })
      .expect(400);
    expect(res.body.message).toBe('You cannot deactivate yourself');

    const me = await t.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(me.isActive).toBe(true);
    await t.http().get('/api/auth/me').set('Cookie', adminCookie).expect(200);
  });

  it("deactivation revokes the target's sessions; reactivation allows login again", async () => {
    const target = await createUser(t.prisma, { email: 'target@camex.aero' });
    const targetCookie1 = await login(t, 'target@camex.aero');
    const targetCookie2 = await login(t, 'target@camex.aero');
    expect(await t.prisma.session.count({ where: { userId: target.id } })).toBe(2);

    const res = await t
      .http()
      .patch(`/api/users/${target.id}`)
      .set('Cookie', adminCookie)
      .send({ isActive: false })
      .expect(200);
    expect(res.body.isActive).toBe(false);

    expect(await t.prisma.session.count({ where: { userId: target.id } })).toBe(0);
    await t.http().get('/api/auth/me').set('Cookie', targetCookie1).expect(401);
    await t.http().get('/api/auth/me').set('Cookie', targetCookie2).expect(401);
    await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'target@camex.aero', password: 'correct-horse-battery-staple' })
      .expect(401);

    // The admin's own session is untouched.
    await t.http().get('/api/auth/me').set('Cookie', adminCookie).expect(200);

    await t
      .http()
      .patch(`/api/users/${target.id}`)
      .set('Cookie', adminCookie)
      .send({ isActive: true })
      .expect(200);
    await login(t, 'target@camex.aero');
  });
});
