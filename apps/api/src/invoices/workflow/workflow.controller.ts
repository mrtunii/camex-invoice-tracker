import { Body, Controller, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  type ApproveInvoiceRequest,
  type InvoiceDetail,
  type InvoiceVersionRequest,
  type MarkPaidRequest,
  type RejectInvoiceRequest,
  type UpdateInvoiceRequest,
  approveInvoiceRequestSchema,
  invoiceVersionRequestSchema,
  markPaidRequestSchema,
  rejectInvoiceRequestSchema,
  updateInvoiceRequestSchema,
  uuidSchema,
} from '@camex/shared';
import { Auth, type AuthContext } from '../../auth/auth-context.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { WorkflowService } from './workflow.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

/**
 * Editing an invoice and moving it through SPEC §6 (T06). Every body carries the `version` it
 * was made against (409 STALE otherwise); every response is the invoice afterwards.
 */
@Controller('invoices')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Patch(':id')
  edit(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateInvoiceRequestSchema)) body: UpdateInvoiceRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.edit(id, body, auth.user.id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(approveInvoiceRequestSchema)) body: ApproveInvoiceRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.approve(id, body, auth.user.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(rejectInvoiceRequestSchema)) body: RejectInvoiceRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.reject(id, body, auth.user.id);
  }

  @Post(':id/reextract')
  @HttpCode(200)
  reextract(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(invoiceVersionRequestSchema)) body: InvoiceVersionRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.reextract(id, body.version, auth.user.id);
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  markPaid(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(markPaidRequestSchema)) body: MarkPaidRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.markPaid(id, body, auth.user.id);
  }

  @Post(':id/undo-payment')
  @HttpCode(200)
  undoPayment(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(invoiceVersionRequestSchema)) body: InvoiceVersionRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.undoPayment(id, body.version, auth.user.id);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(
    @Auth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(invoiceVersionRequestSchema)) body: InvoiceVersionRequest,
  ): Promise<InvoiceDetail> {
    return this.workflow.reopen(id, body.version, auth.user.id);
  }
}
