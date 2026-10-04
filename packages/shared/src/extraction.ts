import { z } from 'zod';

/** SPEC §5 invoices.document_type. */
export const documentTypeSchema = z.enum([
  'invoice',
  'credit_note',
  'proforma',
  'statement',
  'other',
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/** SPEC §5 invoices.category. */
export const invoiceCategorySchema = z.enum([
  'fuel',
  'ground_handling',
  'airport_charges',
  'navigation',
  'catering',
  'maintenance',
  'crew',
  'other',
]);
export type InvoiceCategory = z.infer<typeof invoiceCategorySchema>;

/** SPEC §5 line_items[].kind. */
export const lineItemKindSchema = z.enum(['item', 'fee', 'tax']);
export type LineItemKind = z.infer<typeof lineItemKindSchema>;

// ─── Wire format: what the model returns (extract-v1) ──────────────────────────
//
// Anthropic structured outputs allow at most 16 union-typed and 24 optional properties per
// request ("Schema is too complex for compilation" beyond that). So every property is
// required, nothing is nullable and there are no unions: an absent value is "" (strings) or
// [] (arrays). Patterns accept "" for the same reason.

const wireText = z.string();
const wireDate = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/);
const wireDecimal = z.string().regex(/^(-?\d+(\.\d+)?)?$/);
const wireDayCount = z.string().regex(/^(\d{1,3})?$/);
const wireCurrency = z.string().regex(/^([A-Z]{3})?$/);

export const extractionLineItemV1Schema = z.strictObject({
  kind: lineItemKindSchema,
  description: wireText,
  quantity: wireDecimal,
  uom: wireText,
  unitPrice: wireDecimal,
  amount: wireDecimal,
});

export const extractionBankDetailsV1Schema = z.strictObject({
  beneficiary: wireText,
  bankName: wireText,
  iban: wireText,
  accountNumber: wireText,
  swift: wireText,
  routingNumber: wireText,
  currency: wireCurrency,
});

/** Field order is the order the model writes them in. */
export const extractionOutputV1Schema = z.strictObject({
  documentType: documentTypeSchema,
  vendorName: wireText,
  vendorTaxId: wireText,
  billToName: wireText,
  invoiceNumber: wireText,
  invoiceDate: wireDate,
  serviceDate: wireDate,
  dueDate: wireDate,
  paymentTermsText: wireText,
  paymentTermsDays: wireDayCount,
  disputeWindowDays: wireDayCount,
  category: invoiceCategorySchema,
  description: wireText,
  airportIcao: wireText,
  airportIata: wireText,
  locationText: wireText,
  aircraftRegistration: wireText,
  flightNumbers: z.array(wireText),
  currency: wireCurrency,
  subtotalAmount: wireDecimal,
  taxAmount: wireDecimal,
  totalAmount: wireDecimal,
  amountDue: wireDecimal,
  amountDueCurrency: wireCurrency,
  lineItems: z.array(extractionLineItemV1Schema),
  bankDetails: extractionBankDetailsV1Schema,
  notes: wireText,
});
export type ExtractionOutputV1 = z.infer<typeof extractionOutputV1Schema>;

/** A valid output with nothing extracted (the stub extractor's result). */
export function emptyExtractionOutputV1(): ExtractionOutputV1 {
  return {
    documentType: 'other',
    vendorName: '',
    vendorTaxId: '',
    billToName: '',
    invoiceNumber: '',
    invoiceDate: '',
    serviceDate: '',
    dueDate: '',
    paymentTermsText: '',
    paymentTermsDays: '',
    disputeWindowDays: '',
    category: 'other',
    description: '',
    airportIcao: '',
    airportIata: '',
    locationText: '',
    aircraftRegistration: '',
    flightNumbers: [],
    currency: '',
    subtotalAmount: '',
    taxAmount: '',
    totalAmount: '',
    amountDue: '',
    amountDueCurrency: '',
    lineItems: [],
    bankDetails: {
      beneficiary: '',
      bankName: '',
      iban: '',
      accountNumber: '',
      swift: '',
      routingNumber: '',
      currency: '',
    },
    notes: '',
  };
}

// ─── Domain: normalized extraction (nulls for absent values) ──────────────────
//
// The golden files in fixtures/invoices/expected/*.json use this shape.

/** Decimal as a string, as printed (no rounding): "15617.79", "-12.5". */
export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/);
/** Calendar date, 'YYYY-MM-DD'. */
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

export const extractedLineItemSchema = z.strictObject({
  kind: lineItemKindSchema,
  description: z.string().nullable(),
  quantity: decimalStringSchema.nullable(),
  uom: z.string().nullable(),
  unitPrice: decimalStringSchema.nullable(),
  amount: decimalStringSchema.nullable(),
});
export type ExtractedLineItem = z.infer<typeof extractedLineItemSchema>;

export const bankDetailsSchema = z.strictObject({
  beneficiary: z.string().nullable(),
  bankName: z.string().nullable(),
  iban: z.string().nullable(),
  accountNumber: z.string().nullable(),
  swift: z.string().nullable(),
  routingNumber: z.string().nullable(),
  currency: currencyCodeSchema.nullable(),
});
export type BankDetails = z.infer<typeof bankDetailsSchema>;

export const extractedInvoiceSchema = z.strictObject({
  documentType: documentTypeSchema,
  vendorName: z.string().nullable(),
  vendorTaxId: z.string().nullable(),
  billToName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: calendarDateSchema.nullable(),
  serviceDate: calendarDateSchema.nullable(),
  dueDate: calendarDateSchema.nullable(),
  paymentTermsText: z.string().nullable(),
  paymentTermsDays: z.number().int().nonnegative().nullable(),
  disputeWindowDays: z.number().int().nonnegative().nullable(),
  category: invoiceCategorySchema,
  description: z.string().nullable(),
  airportIcao: z.string().nullable(),
  airportIata: z.string().nullable(),
  locationText: z.string().nullable(),
  aircraftRegistration: z.string().nullable(),
  flightNumbers: z.array(z.string()),
  currency: currencyCodeSchema.nullable(),
  subtotalAmount: decimalStringSchema.nullable(),
  taxAmount: decimalStringSchema.nullable(),
  totalAmount: decimalStringSchema.nullable(),
  amountDue: decimalStringSchema.nullable(),
  amountDueCurrency: currencyCodeSchema.nullable(),
  lineItems: z.array(extractedLineItemSchema),
  /** Null when every field is empty. */
  bankDetails: bankDetailsSchema.nullable(),
  notes: z.string().nullable(),
});
export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;
