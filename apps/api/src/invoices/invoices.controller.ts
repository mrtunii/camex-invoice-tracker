import { Controller, Get, Param } from '@nestjs/common';
import { type InvoiceDetail, uuidSchema } from '@camex/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InvoicesService } from './invoices.service.js';

/** Read-only invoice detail (T03); T06 adds the actions and the review data around it. */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<InvoiceDetail> {
    return this.invoices.get(id);
  }
}
