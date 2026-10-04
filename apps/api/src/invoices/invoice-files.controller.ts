import { NoSuchKey } from '@aws-sdk/client-s3';
import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { uuidSchema } from '@camex/shared';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { inlineContentDisposition } from './content-disposition.js';

/** The original PDF, only ever served through the API behind a session (SPEC §3). */
@Controller('invoices')
export class InvoiceFilesController {
  private readonly logger = new Logger(InvoiceFilesController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get(':id/file')
  async file(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { fileKey: true, fileName: true, fileSize: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    let stream;
    try {
      stream = await this.storage.getStream(invoice.fileKey);
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.logger.error(
          { invoiceId: id, key: invoice.fileKey },
          'invoice file missing from storage',
        );
        throw new NotFoundException('File not found');
      }
      throw error;
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: inlineContentDisposition(invoice.fileName),
      length: invoice.fileSize,
    });
  }
}
