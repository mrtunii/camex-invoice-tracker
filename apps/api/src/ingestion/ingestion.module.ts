import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { IngestionService } from './ingestion.service.js';
import { InvoiceUploadController } from './invoice-upload.controller.js';
import { MailgunController } from './mailgun.controller.js';
import { MailgunFilesInterceptor } from './mailgun-files.interceptor.js';
import { inboundMulterOptions } from './webhook-limits.js';

@Module({
  imports: [
    ExtractionModule,
    // Memory storage (multer's default without `dest`); files never touch the local disk.
    // (Manual upload; the webhook parses with MailgunFilesInterceptor and the same limits.)
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => inboundMulterOptions(env),
    }),
  ],
  controllers: [MailgunController, InvoiceUploadController],
  providers: [IngestionService, MailgunFilesInterceptor],
})
export class IngestionModule {}
