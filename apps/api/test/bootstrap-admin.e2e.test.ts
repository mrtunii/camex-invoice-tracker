import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BootstrapAdminService } from '../src/auth/bootstrap-admin.service.js';
import { verifyPassword } from '../src/auth/password.js';
import { type TestApp, createTestApp, createUser, login, resetDatabase } from './helpers.js';

const BOOTSTRAP = {
  BOOTSTRAP_ADMIN_EMAIL: 'Ops.Admin@Camex.aero',
  BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-password-1',
  BOOTSTRAP_ADMIN_NAME: 'Ops Admin',
};

describe('bootstrap admin from env', () => {
  // A plain app (no bootstrap vars) owns the database between the apps under test.
  let control: TestApp;

  beforeAll(async () => {
    control = await createTestApp();
  });
  afterAll(() => control.close());
  beforeEach(() => resetDatabase(control.prisma));

  /** Boots a second app with BOOTSTRAP_ADMIN_* set, the way main.ts would. */
  async function bootWithBootstrapEnv(): Promise<TestApp> {
    return createTestApp({ env: BOOTSTRAP });
  }

  it('creates the admin on an empty database, who must then change the password', async () => {
    const t = await bootWithBootstrapEnv();
    try {
      const user = await t.prisma.user.findUniqueOrThrow({
        where: { email: 'ops.admin@camex.aero' },
      });
      expect(user).toMatchObject({
        name: 'Ops Admin',
        isActive: true,
        mustChangePassword: true,
        createdById: null,
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);

      const cookie = await login(t, 'ops.admin@camex.aero', BOOTSTRAP.BOOTSTRAP_ADMIN_PASSWORD);
      const me = await t.http().get('/api/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.user.mustChangePassword).toBe(true);
      const blocked = await t.http().get('/api/users').set('Cookie', cookie).expect(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    } finally {
      await t.close();
    }
  });

  it('does nothing when a user exists, even with a different email', async () => {
    const existing = await createUser(control.prisma, { email: 'someone@camex.aero' });

    const t = await bootWithBootstrapEnv();
    await t.close();

    const users = await control.prisma.user.findMany();
    expect(users.map((u) => u.id)).toEqual([existing.id]);
  });

  it('never updates or reactivates a deactivated user with the same email', async () => {
    const existing = await createUser(control.prisma, {
      email: 'ops.admin@camex.aero',
      name: 'Original',
      password: 'original-password-1',
      isActive: false,
    });

    const t = await bootWithBootstrapEnv();
    await t.close();

    const after = await control.prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toEqual(existing);
    expect(await verifyPassword(after.passwordHash, BOOTSTRAP.BOOTSTRAP_ADMIN_PASSWORD)).toBe(
      false,
    );
    expect(await control.prisma.user.count()).toBe(1);
  });

  it('treats a concurrent boot that lost the race as "already created"', async () => {
    const t = await bootWithBootstrapEnv(); // creates the admin
    try {
      await resetDatabase(t.prisma);
      const service = t.app.get(BootstrapAdminService);

      // Two boots at once on an empty table: one creates, the other must not fail.
      const outcomes = await Promise.all([service.run(), service.run()]);
      expect(outcomes).toContain('created');
      expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
      expect(await t.prisma.user.count()).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('fails boot with a clear message on invalid config, without printing the password', async () => {
    const apiRoot = resolve(import.meta.dirname, '..');
    const run = promisify(execFile);
    const result = await run('pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        BOOTSTRAP_ADMIN_EMAIL: 'ops@camex.aero',
        BOOTSTRAP_ADMIN_PASSWORD: 'tooshort',
      },
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: unknown) => {
        const { code, stderr } = error as { code?: number; stderr?: string };
        return { code: code ?? 1, stderr: stderr ?? '' };
      },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid environment configuration/);
    expect(result.stderr).toMatch(/BOOTSTRAP_ADMIN_PASSWORD: Use at least 12 characters/);
    expect(result.stderr).not.toContain('tooshort');
    expect(await control.prisma.user.count()).toBe(0);
  });
});
