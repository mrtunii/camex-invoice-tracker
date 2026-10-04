import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  type IngestResult,
  MAX_UPLOAD_FILES,
  UPLOAD_FIELD_NAME,
  type UploadRejected,
} from '@camex/shared';
import { Auth, type AuthContext } from '../auth/auth-context.js';
import { cleanFileName, isPdf } from './files.js';
import { IngestionService } from './ingestion.service.js';
import { type UploadedFile, toIncomingFile } from './uploaded-file.js';

/** Manual upload (SPEC §4): same pipeline as email, recorded as a `manual` inbound email. */
@Controller('invoices')
export class InvoiceUploadController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('upload')
  @UseInterceptors(FilesInterceptor(UPLOAD_FIELD_NAME, MAX_UPLOAD_FILES))
  async upload(
    @Auth() auth: AuthContext,
    @UploadedFiles() files: UploadedFile[] | undefined,
  ): Promise<IngestResult> {
    const incoming = (files ?? []).map(toIncomingFile);
    if (incoming.length === 0) {
      throw new BadRequestException(
        `Attach 1–${MAX_UPLOAD_FILES} PDF files as "${UPLOAD_FIELD_NAME}"`,
      );
    }

    // All or nothing: one non-PDF rejects the whole batch.
    const rejectedFiles = incoming
      .filter((file) => !isPdf(file))
      .map((f) => cleanFileName(f.filename));
    if (rejectedFiles.length > 0) {
      const body: UploadRejected & { statusCode: number } = {
        statusCode: 400,
        message: 'Only PDF files can be uploaded. Nothing was stored.',
        rejectedFiles,
      };
      throw new BadRequestException(body);
    }

    const outcome = await this.ingestion.ingest({
      provider: 'manual',
      messageId: null,
      fromAddress: auth.user.email,
      sender: null,
      recipient: null,
      subject: 'Manual upload',
      bodyText: null,
      headers: null,
      uploadedById: auth.user.id,
      attachments: incoming,
    });
    // Manual uploads have no Message-Id, so they are never duplicates.
    if (outcome.duplicate) throw new Error('manual upload reported as duplicate');
    return outcome.result;
  }
}
