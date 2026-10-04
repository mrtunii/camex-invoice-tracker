import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';

/**
 * Configured S3 client + bucket for the private file store (MinIO locally).
 * Only wired in T01; ingestion (T02) adds put/get helpers here.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
