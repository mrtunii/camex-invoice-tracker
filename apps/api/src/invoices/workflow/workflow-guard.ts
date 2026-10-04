import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  type InvoiceFlag,
  type InvoiceStatus,
  STALE_MESSAGE,
  type WorkflowConflict,
} from '@camex/shared';
import type { Tx } from '../../evaluation/invoice-evaluator.js';
import { STATUS_PHRASE, WORKFLOW, type WorkflowAction } from './transitions.js';

// The 409s of the workflow (shape: workflowConflictSchema) and the check every human write on an
// invoice starts with.

function conflict(body: Omit<WorkflowConflict, 'statusCode'>): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', ...body });
}

export function staleConflict(): ConflictException {
  return conflict({ code: 'STALE', message: STALE_MESSAGE });
}

export function invalidTransition(action: WorkflowAction, status: InvoiceStatus) {
  return conflict({
    code: 'INVALID_TRANSITION',
    message: `This invoice ${STATUS_PHRASE[status]}, so it can't ${WORKFLOW[action].blocked}.`,
    status,
  });
}

export function missingRequired(flags: readonly InvoiceFlag[]): ConflictException {
  return conflict({
    code: 'MISSING_REQUIRED',
    message: 'Fill in the required fields before approving.',
    fields: flags.map((flag) => ({ field: flag.field ?? '', message: flag.message })),
  });
}

export function vendorRequired(): ConflictException {
  return conflict({
    code: 'VENDOR_REQUIRED',
    message: 'Link the invoice to a vendor before approving.',
  });
}

export function confirmRequired(flags: readonly InvoiceFlag[]): ConflictException {
  return conflict({
    code: 'CONFIRM_REQUIRED',
    message: 'This invoice has errors: confirm them to go ahead.',
    flags: flags.map((flag) => ({ code: flag.code, message: flag.message })),
  });
}

/** 400 in the ZodValidationPipe shape, for checks that need the server (the clock). */
export function invalidField(path: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    issues: [{ path, message }],
  });
}

export interface LockedInvoice {
  status: InvoiceStatus;
  version: number;
}

/**
 * Locks the invoice row for the rest of `tx` and checks, in this order: it exists (404), the
 * request was made against its current version (409 STALE: someone else changed it), and the
 * action is allowed from its status (409 INVALID_TRANSITION). The caller increments the version
 * with its write.
 */
export async function lockForAction(
  tx: Tx,
  invoiceId: string,
  action: WorkflowAction,
  version: number,
): Promise<LockedInvoice> {
  const [row] = await tx.$queryRaw<LockedInvoice[]>`
    SELECT status::text AS status, version FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  if (row === undefined) throw new NotFoundException('Invoice not found');
  if (row.version !== version) throw staleConflict();
  if (!WORKFLOW[action].from.includes(row.status)) throw invalidTransition(action, row.status);
  return row;
}
