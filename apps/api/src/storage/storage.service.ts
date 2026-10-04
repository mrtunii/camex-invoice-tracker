import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
 * The private file store (MinIO locally, Cloudflare R2 when deployed; any S3-compatible bucket).
 * Standard S3 API only; path-style addressing is the S3_FORCE_PATH_STYLE flag. The credentials
 * only need object read, write and list on this one bucket (an R2 "Object Read & Write" token).
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
      // Checksums only where the S3 API requires them, not the SDK's default CRC32 on every
      // upload, which S3-compatible stores support unevenly (R2 lists full-object CRC32 as
      // unsupported). TLS still protects the bytes in transit. No effect on MinIO.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Health probe: lists at most one object, aborted after `timeoutMs`. ListObjectsV2 rather than
   * HeadBucket because a bucket-scoped R2 token may list objects but has no bucket permissions.
   */
  async checkBucket(timeoutMs: number): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }), {
      abortSignal: AbortSignal.timeout(timeoutMs),
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
