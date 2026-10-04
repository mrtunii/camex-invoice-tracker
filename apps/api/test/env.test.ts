import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'super-secret-value',
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    expect(parseEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: 0,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: false,
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
