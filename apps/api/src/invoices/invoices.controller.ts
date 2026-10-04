import { Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import {
  type InvoiceDetail,
  type InvoiceEventsResponse,
  type InvoiceExportQuery,
  type InvoiceListQuery,
  type InvoiceListResponse,
  type InvoiceSummary,
  type InvoiceSummaryQuery,
  type NextToReviewQuery,
  type NextToReviewResponse,
  invoiceExportQuerySchema,
  invoiceListQuerySchema,
  invoiceSummaryQuerySchema,
  nextToReviewQuerySchema,
  uuidSchema,
} from '@camex/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentContentDisposition } from './invoice-csv.js';
import { InvoiceListService } from './invoice-list.service.js';
import { InvoicesService } from './invoices.service.js';

/**
 * The invoices list, its summary and CSV export (T05), the detail (T03) and its activity log, and
 * the review queue's next invoice (T06; the actions are in workflow/). Static paths come before
 * `:id`: Express matches routes in declaration order.
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

  @Get('next-to-review')
  async nextToReview(
    @Query(new ZodValidationPipe(nextToReviewQuerySchema)) query: NextToReviewQuery,
  ): Promise<NextToReviewResponse> {
    return { id: await this.invoiceList.nextToReview(query.after) };
  }

  @Get(':id/events')
  async events(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<InvoiceEventsResponse> {
    return { events: await this.invoices.events(id) };
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<InvoiceDetail> {
    return this.invoices.get(id);
  }
}
