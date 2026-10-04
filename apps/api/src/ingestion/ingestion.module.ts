import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { IngestionService } from './ingestion.service.js';
import { InvoiceUploadController } from './invoice-upload.controller.js';
import { MailgunController } from './mailgun.controller.js';

const MB = 1024 * 1024;

@Module({
  imports: [
    ExtractionModule,
    // Memory storage (multer's default without `dest`); files never touch the local disk.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        limits: {
          fileSize: env.INBOUND_MAX_FILE_MB * MB,
          files: env.INBOUND_MAX_FILES,
          // Text fields (body-plain, body-html, message-headers, …) and their count.
          fieldSize: 10 * MB,
          fields: 500,
        },
        // Attachment names are UTF-8 in practice (multer's default is latin1).
        defParamCharset: 'utf8',
      }),
    }),
  ],
  controllers: [MailgunController, InvoiceUploadController],
  providers: [IngestionService],
})
export class IngestionModule {}
