import { Module } from '@nestjs/common';
import { EvaluationModule } from '../evaluation/evaluation.module.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { InvoiceVendorController } from './invoice-vendor.controller.js';
import { InvoiceVendorService } from './invoice-vendor.service.js';
import { VendorsController } from './vendors.controller.js';
import { VendorsService } from './vendors.service.js';

@Module({
  imports: [EvaluationModule, InvoicesModule],
  controllers: [VendorsController, InvoiceVendorController],
  providers: [VendorsService, InvoiceVendorService],
})
export class VendorsModule {}
