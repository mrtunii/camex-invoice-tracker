import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, login, resetDatabase } from './helpers.js';

const run = promisify(execFile);
const apiRoot = resolve(import.meta.dirname, '..');

/** Runs the real CLI (same entry point as `pnpm create-admin`) against the test database. */
async function createAdmin(args: string[]) {
  try {
    const { stdout, stderr } = await run(
      'pnpm',
      ['exec', 'tsx', 'src/cli/create-admin.ts', ...args],
      {
        cwd: apiRoot,
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('pnpm create-admin', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.prisma));

  it('creates a working admin user', async () => {
    const result = await createAdmin([
      '--email',
      'First.Admin@Camex.aero',
      '--name',
      'First Admin',
      '--password',
      'first-admin-password',
    ]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Created admin first\.admin@camex\.aero/);

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'first.admin@camex.aero' },
    });
    expect(user).toMatchObject({ name: 'First Admin', isActive: true, createdById: null });

    const cookie = await login(t, 'first.admin@camex.aero', 'first-admin-password');
    const me = await t.http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.email).toBe('first.admin@camex.aero');
  });

  it('refuses a duplicate email', async () => {
    const args = [
      '--email',
      'admin@camex.aero',
      '--name',
      'Admin',
      '--password',
      'first-admin-password',
    ];
    expect((await createAdmin(args)).code).toBe(0);

    const second = await createAdmin([
      '--email',
      'ADMIN@camex.aero',
      '--name',
      'Imposter',
      '--password',
      'another-password-1',
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/already exists/);

    const users = await t.prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]?.name).toBe('Admin');
    // The original password still works.
    await login(t, 'admin@camex.aero', 'first-admin-password');
  });

  it('rejects a weak password and missing arguments', async () => {
    const weak = await createAdmin([
      '--email',
      'a@camex.aero',
      '--name',
      'A',
      '--password',
      'short',
    ]);
    expect(weak.code).toBe(1);
    expect(weak.stderr).toMatch(/at least 12 characters/);

    const missing = await createAdmin(['--email', 'a@camex.aero']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Usage:/);

    expect(await t.prisma.user.count()).toBe(0);
  });
});
