import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { emailSchema, hostnameSchema, newPasswordSchema, userNameSchema } from '@camex/shared';
import { z } from 'zod';
import { EXTRACT_EXPIRE_SECONDS } from '../extraction/job-limits.js';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** An origin exactly as browsers send it: scheme://host[:port], lowercase, no path or slash. */
const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be an origin like https://camex-fin.site (scheme and host, no path or trailing slash)');

/** Without WEB_ORIGINS outside production: the Vite dev server, whose proxy forwards its Origin. */
export const DEV_WEB_ORIGINS = ['http://localhost:5180'];

/** Field definitions without cross-field rules (`.pick()` is unavailable once refined). */
export const envObjectSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3180),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /**
   * The web app's origins, comma-separated (required in production). CORS with credentials is
   * enabled for exactly these, and state-changing requests from any other Origin get 403.
   */
  WEB_ORIGINS: z
    .string()
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(z.array(originSchema).min(1))
    .optional(),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),

  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString.default(false),

  /** First admin, created on boot only while the users table is empty. Both or neither. */
  BOOTSTRAP_ADMIN_EMAIL: emailSchema.optional(),
  BOOTSTRAP_ADMIN_PASSWORD: newPasswordSchema.optional(),
  BOOTSTRAP_ADMIN_NAME: userNameSchema.default('Admin'),

  MAILGUN_WEBHOOK_SIGNING_KEY: z.string().min(1),
  /** Whole webhook request (Mailgun); anything larger is answered 406 without being read. */
  INBOUND_MAX_REQUEST_MB: z.coerce.number().int().min(1).max(200).default(30),
  INBOUND_MAX_FILE_MB: z.coerce.number().int().min(1).max(100).default(25),
  INBOUND_MAX_FILES: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Camex's own mail domains, comma-separated (subdomains included). Never used to match a vendor
   * (forwarded mail can carry them) and refused as a vendor domain.
   */
  OWN_EMAIL_DOMAINS: z
    .string()
    .default('camex.aero')
    .transform((value) => value.split(',').map((domain) => domain.trim()))
    .pipe(z.array(hostnameSchema).min(1)),

  EXTRACTOR_PROVIDER: z.enum(['stub', 'anthropic']),
  /** Required when EXTRACTOR_PROVIDER=anthropic. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  EXTRACTION_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  /** Per provider call; with the SDK's one retry, twice this must stay under the job expiry. */
  EXTRACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(90),
  EXTRACTION_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).default(30),
  WORKERS_ENABLED: booleanString.default(true),
});

export const envSchema = envObjectSchema
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.WEB_ORIGINS === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGINS'],
        message: 'required in production (the web app origin, e.g. https://camex-fin.site)',
      });
    }
    if (env.EXTRACTOR_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'required when EXTRACTOR_PROVIDER=anthropic',
      });
    }
    if (env.EXTRACTION_TIMEOUT_SECONDS * 2 >= EXTRACT_EXPIRE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['EXTRACTION_TIMEOUT_SECONDS'],
        message: `must be below ${EXTRACT_EXPIRE_SECONDS / 2}: a call and its one retry must fail before the ${EXTRACT_EXPIRE_SECONDS} s job expiry`,
      });
    }
    if (
      (env.BOOTSTRAP_ADMIN_EMAIL === undefined) !==
      (env.BOOTSTRAP_ADMIN_PASSWORD === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [
          env.BOOTSTRAP_ADMIN_EMAIL === undefined
            ? 'BOOTSTRAP_ADMIN_EMAIL'
            : 'BOOTSTRAP_ADMIN_PASSWORD',
        ],
        message: 'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together',
      });
    }
  })
  .transform((env) => ({ ...env, WEB_ORIGINS: env.WEB_ORIGINS ?? DEV_WEB_ORIGINS }));

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
