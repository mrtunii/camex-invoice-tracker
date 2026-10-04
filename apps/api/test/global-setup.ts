import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadRootEnvFile } from '../src/config/env.js';

/** Creates the test database if needed and applies all migrations to it. */
export default function setup(): void {
  loadRootEnvFile();
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env).');
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must point to a separate database: tests wipe it.');
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}
