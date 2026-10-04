import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  UnauthorizedException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  type IngestResult,
  type MailgunInboundForm,
  mailgunInboundFormSchema,
} from '@camex/shared';
import { Public } from '../auth/public.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { IngestionService } from './ingestion.service.js';
import {
  headerValue,
  parseEmailAddress,
  parseMessageHeaders,
  verifyMailgunSignature,
} from './mailgun.js';
import { type UploadedFile, toIncomingFile } from './uploaded-file.js';

/** `attachment-1`, `attachment-2`, …: keep the email's attachment order. */
function attachmentIndex(file: UploadedFile): number {
  const match = /-(\d+)$/.exec(file.fieldname);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Target of the Mailgun route `forward("https://<host>/api/inbound/mailgun")` (SPEC §4).
 * Authenticated by the Mailgun signature instead of a session. Responds 200 only once the
 * email is committed; any unexpected error is a 500, which makes Mailgun retry.
 */
@Public()
@Controller('inbound')
export class MailgunController {
  private readonly logger = new Logger(MailgunController.name);

  constructor(
    private readonly ingestion: IngestionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('mailgun')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor())
  async receive(
    @Body(new ZodValidationPipe(mailgunInboundFormSchema)) form: MailgunInboundForm,
    @UploadedFiles() files: UploadedFile[] | undefined,
  ): Promise<IngestResult | { duplicate: true }> {
    if (!verifyMailgunSignature(this.env.MAILGUN_WEBHOOK_SIGNING_KEY, form)) {
      this.logger.warn('mailgun webhook rejected: invalid or missing signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const headers = parseMessageHeaders(form.messageHeaders);
    const messageId =
      form.messageId?.trim() ||
      headerValue(headers, 'Message-Id')?.trim() ||
      `mailgun:${form.token ?? ''}`;

    const outcome = await this.ingestion.ingest({
      provider: 'mailgun',
      messageId,
      fromAddress: parseEmailAddress(form.from) ?? parseEmailAddress(form.sender),
      sender: form.sender ?? null,
      recipient: form.recipient ?? null,
      subject: form.subject ?? null,
      bodyText: form.bodyPlain ?? null,
      headers,
      uploadedById: null,
      attachments: [...(files ?? [])]
        .sort((a, b) => attachmentIndex(a) - attachmentIndex(b))
        .map(toIncomingFile),
    });

    if (outcome.duplicate) {
      this.logger.log({ messageId }, 'mailgun webhook: duplicate message ignored');
      return { duplicate: true };
    }
    return outcome.result;
  }
}
