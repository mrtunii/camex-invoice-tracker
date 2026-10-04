import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { EmailHeaders, InboundProvider, IngestResult } from '@camex/shared';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { ExtractionQueue } from '../extraction/extraction-queue.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService, invoicePdfKey } from '../storage/storage.service.js';
import {
  type IncomingFile,
  cleanFileName,
  countPdfPages,
  isPdf,
  sha256Hex,
  stripNul,
  truncate,
} from './files.js';

const BODY_TEXT_MAX_CHARS = 20_000;

/** One email (Mailgun) or one manual upload. */
export interface InboundEmailInput {
  provider: InboundProvider;
  /** Idempotency key; null for manual uploads. */
  messageId: string | null;
  fromAddress: string | null;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  bodyText: string | null;
  headers: EmailHeaders | null;
  uploadedById: string | null;
  attachments: IncomingFile[];
}

export type IngestOutcome = { duplicate: false; result: IngestResult } | { duplicate: true };

/** inbound_emails.attachments element, snake_case as in SPEC §5. */
type StoredAttachment = {
  filename: string;
  content_type: string;
  size: number;
  processed: boolean;
};

interface PreparedPdf {
  invoiceId: string;
  file: IncomingFile;
  fileName: string;
  key: string;
  sha256: string;
  pageCount: number | null;
}

function optionalText(value: string | null, max?: number): string | null {
  if (value === null) return null;
  const clean = stripNul(value);
  return max === undefined ? clean : truncate(clean, max);
}

/**
 * The single ingestion path for Mailgun and manual uploads (SPEC §4): store PDFs, then one
 * transaction for the email, its invoices and their `received` events, then enqueue extraction.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: ExtractionQueue,
  ) {}

  async ingest(input: InboundEmailInput): Promise<IngestOutcome> {
    if (input.messageId !== null && (await this.isKnownMessage(input.messageId))) {
      return { duplicate: true };
    }

    const receivedAt = new Date();
    const inboundEmailId = randomUUID();
    const attachments: StoredAttachment[] = [];
    const pdfs: PreparedPdf[] = [];

    for (const file of input.attachments) {
      const fileName = cleanFileName(stripNul(file.filename));
      const processed = isPdf(file);
      attachments.push({
        filename: fileName,
        content_type: stripNul(file.contentType),
        size: file.buffer.length,
        processed,
      });
      if (!processed) continue;

      const invoiceId = randomUUID();
      pdfs.push({
        invoiceId,
        file,
        fileName,
        key: invoicePdfKey(invoiceId, receivedAt),
        sha256: sha256Hex(file.buffer),
        pageCount: await countPdfPages(file.buffer),
      });
    }

    const uploaded: string[] = [];
    try {
      await Promise.all(
        pdfs.map(async (pdf) => {
          await this.storage.put(pdf.key, pdf.file.buffer, 'application/pdf');
          uploaded.push(pdf.key);
        }),
      );
    } catch (error) {
      this.logOrphans(uploaded, 'upload failed');
      throw error;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.inboundEmail.create({
          data: {
            id: inboundEmailId,
            provider: input.provider,
            messageId: optionalText(input.messageId),
            fromAddress: optionalText(input.fromAddress),
            sender: optionalText(input.sender),
            recipient: optionalText(input.recipient),
            subject: optionalText(input.subject),
            bodyText: optionalText(input.bodyText, BODY_TEXT_MAX_CHARS),
            headers:
              input.headers?.map(([name, value]) => [stripNul(name), stripNul(value)]) ?? undefined,
            attachments,
            receivedAt,
            uploadedById: input.uploadedById,
          },
        });
        await tx.invoice.createMany({
          data: pdfs.map((pdf) => ({
            id: pdf.invoiceId,
            inboundEmailId,
            fileKey: pdf.key,
            fileName: pdf.fileName,
            fileSha256: pdf.sha256,
            fileSize: pdf.file.buffer.length,
            pageCount: pdf.pageCount,
            status: 'processing' as const,
            extractionStatus: 'pending' as const,
          })),
        });
        await tx.invoiceEvent.createMany({
          data: pdfs.map((pdf) => ({
            invoiceId: pdf.invoiceId,
            type: 'received' as const,
            data: { source: input.provider, inboundEmailId },
          })),
        });
      });
    } catch (error) {
      this.logOrphans(uploaded, 'database commit failed');
      // Two deliveries of the same message raced past the duplicate check.
      if (input.messageId !== null && isUniqueViolation(error)) return { duplicate: true };
      throw error;
    }

    const invoiceIds = pdfs.map((pdf) => pdf.invoiceId);
    try {
      await this.queue.enqueue(invoiceIds);
    } catch (error) {
      // The rows are committed; the recovery sweep enqueues them within ~15 minutes.
      this.logger.error(
        { inboundEmailId, err: error instanceof Error ? error.message : String(error) },
        'enqueueing extraction failed; left for the recovery sweep',
      );
    }

    this.logger.log(
      {
        provider: input.provider,
        inboundEmailId,
        messageId: input.messageId,
        sender: input.sender ?? input.fromAddress,
        pdfCount: pdfs.length,
        ignoredCount: attachments.length - pdfs.length,
      },
      'inbound email stored',
    );
    return { duplicate: false, result: { inboundEmailId, invoiceIds } };
  }

  private async isKnownMessage(messageId: string): Promise<boolean> {
    const existing = await this.prisma.inboundEmail.findUnique({
      where: { messageId: stripNul(messageId) },
      select: { id: true },
    });
    return existing !== null;
  }

  private logOrphans(keys: string[], reason: string): void {
    if (keys.length > 0) this.logger.warn({ keys, reason }, 'orphaned files in storage');
  }
}
