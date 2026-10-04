import type { InvoiceEventType, InvoiceStatus } from '@camex/shared';

// SPEC §6 as data: what each human action on an invoice may start from, where it leads, and the
// event it writes. WorkflowService applies it; nothing else decides whether an action is allowed.

export type WorkflowAction =
  | 'edit'
  | 'linkVendor'
  | 'trustBankDetails'
  | 'approve'
  | 'reject'
  | 'reextract'
  | 'markPaid'
  | 'undoPayment'
  | 'reopen';

export interface WorkflowRule {
  from: readonly InvoiceStatus[];
  /** The status afterwards; null: the status doesn't change. */
  to: InvoiceStatus | null;
  event: InvoiceEventType;
  /** "This invoice is …, so it can't <blocked>." */
  blocked: string;
}

export const WORKFLOW: Record<WorkflowAction, WorkflowRule> = {
  edit: { from: ['needs_review'], to: null, event: 'edited', blocked: 'be edited' },
  linkVendor: {
    from: ['needs_review'],
    to: null,
    event: 'vendor_linked',
    blocked: 'be linked to a vendor',
  },
  trustBankDetails: {
    from: ['needs_review', 'unpaid'],
    to: null,
    event: 'bank_account_trusted',
    blocked: 'have its bank details trusted',
  },
  approve: { from: ['needs_review'], to: 'unpaid', event: 'approved', blocked: 'be approved' },
  reject: { from: ['needs_review'], to: 'rejected', event: 'rejected', blocked: 'be rejected' },
  reextract: {
    from: ['needs_review'],
    to: 'processing',
    event: 'reextracted',
    blocked: 'be read again',
  },
  markPaid: { from: ['unpaid'], to: 'paid', event: 'paid', blocked: 'be marked paid' },
  undoPayment: {
    from: ['paid'],
    to: 'unpaid',
    event: 'payment_undone',
    blocked: 'have its payment undone',
  },
  reopen: {
    from: ['unpaid', 'rejected'],
    to: 'needs_review',
    event: 'reopened',
    blocked: 'be reopened',
  },
};

/** How a status reads in "This invoice …". */
export const STATUS_PHRASE: Record<InvoiceStatus, string> = {
  processing: 'is still being read',
  needs_review: 'is waiting for review',
  unpaid: 'is approved and waiting for payment',
  paid: 'is paid',
  rejected: 'is rejected',
};
