import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../src/storage/storage.service.js';
import { type TestApp, createTestApp } from './helpers.js';

describe('storage module', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('is configured against the docker-compose bucket', async () => {
    const storage = t.app.get(StorageService);
    expect(storage.bucket).toBe(t.env.S3_BUCKET);
    const res = await storage.client.send(new HeadBucketCommand({ Bucket: storage.bucket }));
    expect(res.$metadata.httpStatusCode).toBe(200);
  });
});
