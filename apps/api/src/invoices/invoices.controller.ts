import { Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import {
  type InvoiceDetail,
  type InvoiceExportQuery,
  type InvoiceListQuery,
  type InvoiceListResponse,
  type InvoiceSummary,
  type InvoiceSummaryQuery,
  invoiceExportQuerySchema,
  invoiceListQuerySchema,
  invoiceSummaryQuerySchema,
  uuidSchema,
} from '@camex/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentContentDisposition } from './invoice-csv.js';
import { InvoiceListService } from './invoice-list.service.js';
import { InvoicesService } from './invoices.service.js';

/**
 * The invoices list, its summary and CSV export (T05), and the read-only detail (T03; T06 adds
 * the actions). Static paths come before `:id`: Express matches routes in declaration order.
 */
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly invoiceList: InvoiceListService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(invoiceListQuerySchema)) query: InvoiceListQuery,
  ): Promise<InvoiceListResponse> {
    return this.invoiceList.list(query);
  }

  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(invoiceSummaryQuerySchema)) query: InvoiceSummaryQuery,
  ): Promise<InvoiceSummary> {
    return this.invoiceList.summary(query);
  }

  @Get('export.csv')
  @Header('Cache-Control', 'private, no-store')
  async exportCsv(
    @Query(new ZodValidationPipe(invoiceExportQuerySchema)) query: InvoiceExportQuery,
  ): Promise<StreamableFile> {
    const { fileName, content } = await this.invoiceList.exportCsv(query);
    return new StreamableFile(Buffer.from(content, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: attachmentContentDisposition(fileName),
    });
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<InvoiceDetail> {
    return this.invoices.get(id);
  }
}
