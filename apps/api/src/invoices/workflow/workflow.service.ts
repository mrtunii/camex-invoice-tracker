import { Injectable, Logger } from '@nestjs/common';
import type {
  ApproveInvoiceRequest,
  InvoiceDetail,
  InvoiceFlag,
  MarkPaidRequest,
  RejectInvoiceRequest,
  UpdateInvoiceRequest,
} from '@camex/shared';
import { InvoiceEvaluator, type Tx } from '../../evaluation/invoice-evaluator.js';
import { ExtractionQueue } from '../../extraction/extraction-queue.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { trustInvoiceBankDetails } from '../../vendors/trust-bank-details.js';
import { lockVendors } from '../../vendors/vendor-rules.js';
import { fromDateColumn, toDateColumn } from '../invoice-columns.js';
import { InvoicesService } from '../invoices.service.js';
import { diffEdit, editableValues } from './invoice-edit.js';
import { WORKFLOW, type WorkflowAction } from './transitions.js';
import {
  confirmRequired,
  invalidField,
  type LockedInvoice,
  lockForAction,
  missingRequired,
  vendorRequired,
} from './workflow-guard.js';

/** What an action writes besides the status, the version and its event's type. */
interface Applied<R> {
  data: Prisma.InvoiceUncheckedUpdateInput;
  event: Prisma.InputJsonObject;
  /** Handed back to the caller after the commit. */
  result?: R;
}

interface ActionContext {
  tx: Tx;
  locked: LockedInvoice;
  today: string;
}

function errorFlags(flags: readonly InvoiceFlag[]): InvoiceFlag[] {
  return flags.filter((flag) => flag.severity === 'error');
}

/** Each code once, for `overriddenFlags`. */
function codes(flags: readonly InvoiceFlag[]): string[] {
  return [...new Set(flags.map((flag) => flag.code))];
}

/**
 * The invoice workflow (SPEC §6, T06): edits and transitions. Each runs in one transaction that
 * locks the row, checks the version and the status (WORKFLOW), writes the change with its event
 * and the user, increments the version and re-evaluates the invoice; after the commit the
 * invoices related to it are re-evaluated too. Returns the invoice as GET /api/invoices/:id does.
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: InvoiceEvaluator,
    private readonly invoices: InvoicesService,
    private readonly extractionQueue: ExtractionQueue,
  ) {}

  /** PATCH: only the fields that change are written; nothing changes → no event, same version. */
  async edit(
    invoiceId: string,
    request: UpdateInvoiceRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    const today = this.evaluator.today();
    const previousInvoiceNumber = await this.prisma.$transaction(async (tx) => {
      await lockForAction(tx, invoiceId, 'edit', request.version);
      const row = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const edit = diffEdit(editableValues(row), request);
      if (edit.changed.length === 0) return undefined;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { ...edit.columns, version: { increment: 1 } },
      });
      await tx.invoiceEvent.create({
        // Bank details are stored with their values (an audit must show an IBAN change); they
        // are never logged.
        data: { invoiceId, userId, type: 'edited', data: edit.event as Prisma.InputJsonObject },
      });
      await this.evaluator.evaluate(tx, invoiceId, today);
      this.logger.log({ invoiceId, userId, fields: edit.changed }, 'invoice edited');
      return row.invoiceNumber;
    });
    if (previousInvoiceNumber !== undefined) {
      // Also the invoices that shared the old number (their duplicate flag may clear).
      await this.evaluator.tryEvaluateWithRelated(invoiceId, { previousInvoiceNumber });
    }
    return this.invoices.get(invoiceId);
  }

  /**
   * needs_review → unpaid. Re-evaluates first; then required fields (never overridable), a
   * linked vendor, and error flags (`confirmErrors`, recorded as overriddenFlags), all checked
   * before `trustBankDetails` adds the account, so trusting can't clear a BANK_UNKNOWN.
   */
  async approve(
    invoiceId: string,
    request: ApproveInvoiceRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    const trusted = await this.transition<string>(
      invoiceId,
      'approve',
      request.version,
      userId,
      async ({ tx, today }) => {
        const flags = (await this.evaluator.evaluate(tx, invoiceId, today))?.flags ?? [];
        const missing = flags.filter((flag) => flag.code === 'MISSING_REQUIRED');
        if (missing.length > 0) throw missingRequired(missing);
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: invoiceId },
          select: { vendorId: true, bankDetails: true },
        });
        if (invoice.vendorId === null) throw vendorRequired();
        const errors = errorFlags(flags);
        if (errors.length > 0 && request.confirmErrors !== true) throw confirmRequired(errors);

        const trust =
          request.trustBankDetails === true
            ? await trustInvoiceBankDetails(tx, {
                invoiceId,
                vendorId: invoice.vendorId,
                bankDetails: invoice.bankDetails,
                userId,
              })
            : { added: false };
        return {
          data: { approvedAt: new Date(), approvedById: userId },
          event: { overriddenFlags: codes(errors) },
          // The vendor whose trusted accounts changed.
          result: trust.added ? invoice.vendorId : undefined,
        };
      },
      // Bank accounts are a read-modify-write of the vendor: vendors first, then the invoice (T04).
      { lockVendors: request.trustBankDetails === true },
    );
    if (trusted !== undefined) {
      this.logger.log(
        { userId, vendorId: trusted, action: 'bank_account_trusted' },
        'vendor action',
      );
      await this.evaluator.reevaluateVendor(trusted, { rematch: false });
    }
    return this.invoices.get(invoiceId);
  }

  /** needs_review → rejected, with a reason (and a note, required for `other`). */
  async reject(
    invoiceId: string,
    request: RejectInvoiceRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    await this.transition(invoiceId, 'reject', request.version, userId, () => ({
      data: {
        rejectedAt: new Date(),
        rejectedById: userId,
        rejectionReason: request.reason,
        rejectionNote: request.note,
      },
      event: { reason: request.reason, note: request.note },
    }));
    return this.invoices.get(invoiceId);
  }

  /**
   * needs_review → processing, and a new extraction job. The extraction overwrites every
   * extracted field (edits too) and the due date's source; it keeps the vendor link.
   */
  async reextract(invoiceId: string, version: number, userId: string): Promise<InvoiceDetail> {
    await this.transition(invoiceId, 'reextract', version, userId, () => ({
      data: { extractionStatus: 'pending', extractionError: null },
      event: {},
    }));
    try {
      await this.extractionQueue.enqueue([invoiceId]);
    } catch (error) {
      // Committed as processing: the recovery sweep re-enqueues it within 10 minutes.
      this.logger.error(
        { invoiceId, err: error instanceof Error ? error.message : String(error) },
        'enqueueing the re-extraction failed',
      );
    }
    return this.invoices.get(invoiceId);
  }

  /**
   * unpaid → paid. Paying is when fraud costs money: the invoice is re-evaluated first and error
   * flags (a BANK_UNKNOWN after a trusted account was removed) need `confirmErrors`.
   */
  async markPaid(
    invoiceId: string,
    request: MarkPaidRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    if (request.paidAt > this.evaluator.today()) {
      throw invalidField('paidAt', "The payment date can't be after today");
    }
    await this.transition(invoiceId, 'markPaid', request.version, userId, async (ctx) => {
      const flags = (await this.evaluator.evaluate(ctx.tx, invoiceId, ctx.today))?.flags ?? [];
      const errors = errorFlags(flags);
      if (errors.length > 0 && request.confirmErrors !== true) throw confirmRequired(errors);
      return {
        data: {
          paidAt: toDateColumn(request.paidAt),
          paidById: userId,
          paymentReference: request.paymentReference,
          paymentNote: request.paymentNote,
        },
        event: {
          paidAt: request.paidAt,
          reference: request.paymentReference,
          overriddenFlags: codes(errors),
        },
      };
    });
    return this.invoices.get(invoiceId);
  }

  /** paid → unpaid: the payment fields are cleared; the event keeps the old date. */
  async undoPayment(invoiceId: string, version: number, userId: string): Promise<InvoiceDetail> {
    await this.transition(invoiceId, 'undoPayment', version, userId, async ({ tx }) => {
      const { paidAt } = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { paidAt: true },
      });
      return {
        data: { paidAt: null, paidById: null, paymentReference: null, paymentNote: null },
        event: { previousPaidAt: fromDateColumn(paidAt) },
      };
    });
    return this.invoices.get(invoiceId);
  }

  /** unpaid or rejected → needs_review: the approval or rejection is cleared (events keep it). */
  async reopen(invoiceId: string, version: number, userId: string): Promise<InvoiceDetail> {
    await this.transition(invoiceId, 'reopen', version, userId, ({ locked }) => ({
      data:
        locked.status === 'unpaid'
          ? { approvedAt: null, approvedById: null }
          : {
              rejectedAt: null,
              rejectedById: null,
              rejectionReason: null,
              rejectionNote: null,
            },
      event: { from: locked.status },
    }));
    return this.invoices.get(invoiceId);
  }

  /**
   * Applies one WORKFLOW rule: lock + version + status checks, the action's own checks and data
   * (`apply`), the status, the version increment, the event, the evaluation; then, after the
   * commit, the invoice and its related invoices are evaluated again.
   */
  private async transition<R = undefined>(
    invoiceId: string,
    action: WorkflowAction,
    version: number,
    userId: string,
    apply: (ctx: ActionContext) => Applied<R> | Promise<Applied<R>>,
    options: { lockVendors?: boolean } = {},
  ): Promise<R | undefined> {
    const rule = WORKFLOW[action];
    const today = this.evaluator.today();
    const result = await this.prisma.$transaction(async (tx) => {
      if (options.lockVendors === true) await lockVendors(tx);
      const locked = await lockForAction(tx, invoiceId, action, version);
      const { data, event, result } = await apply({ tx, locked, today });
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          ...data,
          ...(rule.to === null ? {} : { status: rule.to }),
          version: { increment: 1 },
        },
      });
      await tx.invoiceEvent.create({ data: { invoiceId, userId, type: rule.event, data: event } });
      await this.evaluator.evaluate(tx, invoiceId, today);
      return result;
    });
    this.logger.log({ invoiceId, userId, action }, 'invoice workflow');
    await this.evaluator.tryEvaluateWithRelated(invoiceId);
    return result;
  }
}
