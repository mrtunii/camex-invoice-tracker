import { Module } from '@nestjs/common';
import { InvoiceFilesController } from './invoice-files.controller.js';

@Module({
  controllers: [InvoiceFilesController],
})
export class InvoicesModule {}
