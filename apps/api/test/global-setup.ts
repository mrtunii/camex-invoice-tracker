import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadRootEnvFile, parseEnv } from '../src/config/env.js';

/**
 * Creates the test database if needed and applies all migrations to it; creates the test
 * bucket and empties it (the test database is wiped too, so leftover files are orphans).
 */
export default async function setup(): Promise<void> {
  loadRootEnvFile();
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env).');
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must point to a separate database: tests wipe it.');
  }
  const testBucket = process.env.TEST_S3_BUCKET;
  if (!testBucket || testBucket === process.env.S3_BUCKET) {
    throw new Error('TEST_S3_BUCKET must be set to a separate bucket: tests empty it.');
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });

  const env = parseEnv({ ...process.env, S3_BUCKET: testBucket });
  const s3 = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: testBucket })).catch((error: unknown) => {
      if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
    });
    for (;;) {
      const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: testBucket }));
      const keys = Contents.flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
      if (keys.length === 0) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: testBucket, Delete: { Objects: keys } }));
    }
  } finally {
    s3.destroy();
  }
}
