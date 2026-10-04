import type {
  BankDetails,
  DocumentType,
  EditableField,
  FlagCode,
  InvoiceCategory,
  InvoiceStatus,
  LineItemKind,
  RejectionReason,
} from '@camex/shared';

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

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  proforma: 'Proforma',
  statement: 'Statement',
  other: 'Other document',
};

export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  duplicate: 'Duplicate',
  not_invoice: 'Not an invoice',
  disputed: 'Disputed with vendor',
  other: 'Other',
};

export const LINE_KIND_LABELS: Record<LineItemKind, string> = {
  item: 'Item',
  fee: 'Fee',
  tax: 'Tax',
};

/** Form labels of the editable fields; the activity log names changes with the same words. */
export const FIELD_LABELS: Record<EditableField, string> = {
  documentType: 'Document type',
  vendorName: 'Vendor',
  vendorTaxId: 'Vendor tax ID',
  billToName: 'Billed to',
  invoiceNumber: 'Invoice #',
  invoiceDate: 'Invoice date',
  serviceDate: 'Service date',
  dueDate: 'Due date',
  paymentTermsText: 'Terms',
  paymentTermsDays: 'Terms in days',
  disputeWindowDays: 'Dispute window',
  category: 'Category',
  description: 'Description',
  airportIcao: 'Airport ICAO',
  airportIata: 'Airport IATA',
  locationText: 'Location',
  aircraftRegistration: 'Aircraft',
  flightNumbers: 'Flights',
  currency: 'Invoice currency',
  subtotalAmount: 'Subtotal',
  taxAmount: 'Tax',
  totalAmount: 'Total',
  amountDue: 'Amount due',
  amountDueCurrency: 'Pay in',
  lineItems: 'Line items',
  bankDetails: 'Bank details',
  notes: 'Notes',
};

export const BANK_FIELD_LABELS: Record<keyof BankDetails, string> = {
  beneficiary: 'Beneficiary',
  bankName: 'Bank',
  iban: 'IBAN',
  accountNumber: 'Account number',
  swift: 'SWIFT',
  routingNumber: 'Routing number',
  currency: 'Account currency',
};

/**
 * Error flags in a few words, for "approved despite …" in the activity log (codes never appear
 * in the UI). Only error flags can be overridden.
 */
export const OVERRIDDEN_FLAG_WORDS: Partial<Record<FlagCode, string>> = {
  EXTRACTION_FAILED: 'the failed reading',
  MISSING_REQUIRED: 'missing fields',
  TOTAL_MATH: 'line items not adding up to the total',
  DUE_BEFORE_INVOICE: 'a due date before the invoice date',
  DUPLICATE_FILE: 'a duplicate file',
  DUPLICATE_NUMBER: 'a duplicate invoice number',
  BANK_UNKNOWN: 'bank details that differ from the ones on file',
};
