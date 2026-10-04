import { type DueDateSource, addDays } from '@camex/shared';

export interface DateFields {
  invoiceDate: string | null;
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  paymentTermsDays: number | null;
  disputeWindowDays: number | null;
}

export interface DerivedDates {
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  disputeDeadline: string | null;
}

/**
 * SPEC §7. A printed or manually entered due date is kept. Otherwise it is invoice_date +
 * payment_terms_days, else invoice_date + the vendor's default terms, else null. The dispute
 * deadline is always invoice_date + dispute_window_days.
 */
export function deriveDates(
  invoice: DateFields,
  vendor: { defaultPaymentTermsDays: number | null } | null,
): DerivedDates {
  const { invoiceDate } = invoice;
  const disputeDeadline =
    invoiceDate !== null && invoice.disputeWindowDays !== null
      ? addDays(invoiceDate, invoice.disputeWindowDays)
      : null;

  if (invoice.dueDateSource === 'printed' || invoice.dueDateSource === 'manual') {
    return { dueDate: invoice.dueDate, dueDateSource: invoice.dueDateSource, disputeDeadline };
  }
  if (invoiceDate !== null && invoice.paymentTermsDays !== null) {
    return {
      dueDate: addDays(invoiceDate, invoice.paymentTermsDays),
      dueDateSource: 'terms',
      disputeDeadline,
    };
  }
  const vendorTerms = vendor?.defaultPaymentTermsDays ?? null;
  if (invoiceDate !== null && vendorTerms !== null) {
    return {
      dueDate: addDays(invoiceDate, vendorTerms),
      dueDateSource: 'vendor_default',
      disputeDeadline,
    };
  }
  return { dueDate: null, dueDateSource: null, disputeDeadline };
}
