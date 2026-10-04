import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  WEB_DIST_DIR: z.string().min(1).optional(),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),

  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString.default(false),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

/** Validates configuration. Empty strings count as unset. Never echoes values (they may be secrets). */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(defined);
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  throw new EnvValidationError(
    `Invalid environment configuration:\n${problems.join('\n')}\nSee .env.example for the full list of variables.`,
  );
}

/**
 * Loads the repo-root .env when running inside the monorepo (dev server, tests, CLI).
 * Variables already set in the environment win. In production there is no file and this is a no-op.
 */
export function loadRootEnvFile(): void {
  // src/config (or dist/config) → apps/api → repo root
  const file = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
