import { Module } from '@nestjs/common';
import { InvoiceFilesController } from './invoice-files.controller.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';

@Module({
  controllers: [InvoicesController, InvoiceFilesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
