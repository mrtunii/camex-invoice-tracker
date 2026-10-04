import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';

/** `invoices/{yyyy}/{mm}/{invoiceId}.pdf` (UTC month of receipt). The original filename lives only in the DB. */
export function invoicePdfKey(invoiceId: string, receivedAt: Date): string {
  const yyyy = String(receivedAt.getUTCFullYear());
  const mm = String(receivedAt.getUTCMonth() + 1).padStart(2, '0');
  return `invoices/${yyyy}/${mm}/${invoiceId}.pdf`;
}

/**
 * The private file store (MinIO locally, any S3-compatible bucket in production). Standard S3
 * API only; path-style addressing is the S3_FORCE_PATH_STYLE flag.
 */
@Injectable()
export class StorageService implements OnApplicationShutdown {
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

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    // In Node the SDK returns an http.IncomingMessage (a Readable).
    if (!(Body instanceof Readable)) throw new Error(`S3 object ${key} has no readable body`);
    return Body;
  }

  // After the HTTP server and job workers have stopped (they may still be streaming files).
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
