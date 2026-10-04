import type { InvoiceCategory } from '@camex/shared';

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
