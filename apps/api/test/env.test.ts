import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'super-secret-value',
  MAILGUN_WEBHOOK_SIGNING_KEY: 'signing-key',
  EXTRACTOR_PROVIDER: 'stub',
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    expect(parseEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3180,
      LOG_LEVEL: 'info',
      TRUST_PROXY: 0,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: false,
      BOOTSTRAP_ADMIN_NAME: 'Admin',
      INBOUND_MAX_REQUEST_MB: 30,
      INBOUND_MAX_FILE_MB: 25,
      INBOUND_MAX_FILES: 20,
      EXTRACTION_MODEL: 'claude-sonnet-5-5',
      EXTRACTION_TIMEOUT_SECONDS: 90,
      EXTRACTION_RETRY_DELAY_SECONDS: 30,
      WORKERS_ENABLED: true,
    });
    expect(parseEnv(valid).BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
  });

  describe('WEB_ORIGINS', () => {
    it('parses a comma-separated list of exact origins', () => {
      expect(
        parseEnv({ ...valid, WEB_ORIGINS: 'https://camex-fin.site, http://localhost:8090' })
          .WEB_ORIGINS,
      ).toEqual(['https://camex-fin.site', 'http://localhost:8090']);
    });

    it('defaults to the Vite dev server outside production', () => {
      expect(parseEnv(valid).WEB_ORIGINS).toEqual(['http://localhost:5180']);
    });

    it('is required in production', () => {
      expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
        /WEB_ORIGINS: required in production/,
      );
      expect(
        parseEnv({ ...valid, NODE_ENV: 'production', WEB_ORIGINS: 'https://camex-fin.site' })
          .WEB_ORIGINS,
      ).toEqual(['https://camex-fin.site']);
    });

    it.each([
      'https://camex-fin.site/',
      'https://camex-fin.site/app',
      'https://Camex-Fin.site',
      'camex-fin.site',
      'ftp://camex-fin.site',
      'https://camex-fin.site,',
    ])('rejects %s (origins are compared exactly as browsers send them)', (value) => {
      expect(() => parseEnv({ ...valid, WEB_ORIGINS: value })).toThrow(/WEB_ORIGINS/);
    });
  });

  describe('BOOTSTRAP_ADMIN_*', () => {
    const PASSWORD = 'bootstrap-secret-password';

    it('accepts email + password together and normalizes the email', () => {
      const env = parseEnv({
        ...valid,
        BOOTSTRAP_ADMIN_EMAIL: ' Ops@Camex.aero ',
        BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
        BOOTSTRAP_ADMIN_NAME: 'Ops',
      });
      expect(env).toMatchObject({
        BOOTSTRAP_ADMIN_EMAIL: 'ops@camex.aero',
        BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
        BOOTSTRAP_ADMIN_NAME: 'Ops',
      });
    });

    it.each([
      [
        'email without password',
        { BOOTSTRAP_ADMIN_EMAIL: 'ops@camex.aero' },
        /BOOTSTRAP_ADMIN_PASSWORD: .*set together/,
      ],
      [
        'password without email',
        { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        /BOOTSTRAP_ADMIN_EMAIL: .*set together/,
      ],
      [
        'a password that breaks the policy',
        { BOOTSTRAP_ADMIN_EMAIL: 'ops@camex.aero', BOOTSTRAP_ADMIN_PASSWORD: 'short-pw' },
        /BOOTSTRAP_ADMIN_PASSWORD: Use at least 12 characters/,
      ],
      [
        'an invalid email',
        { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        /BOOTSTRAP_ADMIN_EMAIL: Enter a valid email address/,
      ],
    ])('rejects %s without echoing the password', (_case, vars, message) => {
      const attempt = () => parseEnv({ ...valid, ...vars });
      expect(attempt).toThrow(EnvValidationError);
      expect(attempt).toThrow(message);
      try {
        attempt();
      } catch (error) {
        expect(String(error)).not.toContain('short-pw');
        expect(String(error)).not.toContain(PASSWORD);
      }
    });
  });

  describe('extraction provider', () => {
    it('requires ANTHROPIC_API_KEY for the anthropic provider, without echoing anything', () => {
      const attempt = () => parseEnv({ ...valid, EXTRACTOR_PROVIDER: 'anthropic' });
      expect(attempt).toThrow(/ANTHROPIC_API_KEY: required when EXTRACTOR_PROVIDER=anthropic/);
      expect(attempt).toThrow(EnvValidationError);

      const key = 'sk-ant-test-key-never-printed';
      const env = parseEnv({ ...valid, EXTRACTOR_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: key });
      expect(env).toMatchObject({ EXTRACTOR_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: key });
      try {
        parseEnv({ ...valid, EXTRACTOR_PROVIDER: 'nope', ANTHROPIC_API_KEY: key });
        expect.unreachable();
      } catch (error) {
        expect(String(error)).toMatch(/EXTRACTOR_PROVIDER/);
        expect(String(error)).not.toContain(key);
      }
    });

    it('keeps two provider calls inside the 300 s job expiry', () => {
      expect(
        parseEnv({ ...valid, EXTRACTION_TIMEOUT_SECONDS: '149' }).EXTRACTION_TIMEOUT_SECONDS,
      ).toBe(149);
      expect(() => parseEnv({ ...valid, EXTRACTION_TIMEOUT_SECONDS: '150' })).toThrow(
        /EXTRACTION_TIMEOUT_SECONDS: must be below 150/,
      );
    });
  });

  it('fails fast listing every problem, treating empty strings as missing', () => {
    const attempt = () =>
      parseEnv({ ...valid, DATABASE_URL: 'mysql://x', S3_BUCKET: '', PORT: 'abc' });
    expect(attempt).toThrow(EnvValidationError);
    expect(attempt).toThrow(/DATABASE_URL: must be a postgresql:\/\/ URL/);
    expect(attempt).toThrow(/S3_BUCKET/);
    expect(attempt).toThrow(/PORT/);
  });

  it('never echoes values', () => {
    try {
      parseEnv({
        ...valid,
        S3_SECRET_ACCESS_KEY: undefined,
        S3_ENDPOINT: 'not a url super-secret',
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/S3_SECRET_ACCESS_KEY/);
      expect(String(error)).not.toContain('super-secret');
    }
  });
});
