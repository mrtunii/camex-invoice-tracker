import { Module } from '@nestjs/common';
import { InvoiceFilesController } from './invoice-files.controller.js';
import { InvoiceListService } from './invoice-list.service.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';

@Module({
  controllers: [InvoicesController, InvoiceFilesController],
  providers: [InvoicesService, InvoiceListService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
