import type { InvoiceCategory, InvoiceStatus } from '@camex/shared';

export const CATEGORY_LABELS: Record<InvoiceCategory, string> = {
  fuel: 'Fuel',
  ground_handling: 'Ground handling',
  airport_charges: 'Airport charges',
  navigation: 'Navigation',
  catering: 'Catering',
  maintenance: 'Maintenance',
  crew: 'Crew',
  other: 'Other',
};

/** One vocabulary everywhere: tabs, Home, toasts, empty states (T05b §2). */
export const STATUS_WORDS: Record<InvoiceStatus, string> = {
  processing: 'Reading…',
  needs_review: 'To review',
  unpaid: 'To pay',
  paid: 'Paid',
  rejected: 'Rejected',
};
