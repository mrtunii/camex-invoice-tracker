import {
  type BankDetails,
  type ExtractedInvoice,
  type ExtractedLineItem,
  bankDetailsSchema,
  extractedLineItemSchema,
} from '@camex/shared';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';

// Invoice columns ↔ API shapes. jsonb keys stay snake_case like the columns (SPEC §5);
// the API is camelCase. Calendar dates are `date` columns, decimals `numeric`.

const lineItemJsonSchema = z.object({
  kind: extractedLineItemSchema.shape.kind,
  description: z.string().nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  unit_price: z.string().nullable(),
  amount: z.string().nullable(),
});

const bankDetailsJsonSchema = z.object({
  beneficiary: z.string().nullable(),
  bank_name: z.string().nullable(),
  iban: z.string().nullable(),
  account_number: z.string().nullable(),
  swift: z.string().nullable(),
  routing_number: z.string().nullable(),
  currency: z.string().nullable(),
});

/** 'YYYY-MM-DD' → the Date Prisma writes to a `date` column (UTC midnight). */
export function toDateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

export function fromDateColumn(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Plain notation, never exponential ("0.0000001", not "1e-7"). */
export function fromDecimalColumn(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}

export function lineItemsToJson(items: readonly ExtractedLineItem[]): Prisma.InputJsonValue {
  return items.map((item) => ({
    kind: item.kind,
    description: item.description,
    quantity: item.quantity,
    uom: item.uom,
    unit_price: item.unitPrice,
    amount: item.amount,
  }));
}

export function lineItemsFromJson(value: Prisma.JsonValue): ExtractedLineItem[] {
  return z
    .array(lineItemJsonSchema)
    .parse(value)
    .map((item) =>
      extractedLineItemSchema.parse({
        kind: item.kind,
        description: item.description,
        quantity: item.quantity,
        uom: item.uom,
        unitPrice: item.unit_price,
        amount: item.amount,
      }),
    );
}

export function bankDetailsToJson(
  details: BankDetails | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (details === null) return Prisma.DbNull;
  return {
    beneficiary: details.beneficiary,
    bank_name: details.bankName,
    iban: details.iban,
    account_number: details.accountNumber,
    swift: details.swift,
    routing_number: details.routingNumber,
    currency: details.currency,
  };
}

export function bankDetailsFromJson(value: Prisma.JsonValue | null): BankDetails | null {
  if (value === null) return null;
  const details = bankDetailsJsonSchema.parse(value);
  return bankDetailsSchema.parse({
    beneficiary: details.beneficiary,
    bankName: details.bank_name,
    iban: details.iban,
    accountNumber: details.account_number,
    swift: details.swift,
    routingNumber: details.routing_number,
    currency: details.currency,
  });
}

/** Every extracted field, as invoice columns. */
export function extractedInvoiceColumns(
  invoice: ExtractedInvoice,
): Prisma.InvoiceUpdateManyMutationInput {
  return {
    documentType: invoice.documentType,
    vendorName: invoice.vendorName,
    vendorTaxId: invoice.vendorTaxId,
    billToName: invoice.billToName,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: toDateColumn(invoice.invoiceDate),
    serviceDate: toDateColumn(invoice.serviceDate),
    dueDate: toDateColumn(invoice.dueDate),
    paymentTermsText: invoice.paymentTermsText,
    paymentTermsDays: invoice.paymentTermsDays,
    disputeWindowDays: invoice.disputeWindowDays,
    category: invoice.category,
    description: invoice.description,
    airportIcao: invoice.airportIcao,
    airportIata: invoice.airportIata,
    locationText: invoice.locationText,
    aircraftRegistration: invoice.aircraftRegistration,
    flightNumbers: invoice.flightNumbers,
    currency: invoice.currency,
    // Prisma takes decimal strings as they are: no float on the way to `numeric`.
    subtotalAmount: invoice.subtotalAmount,
    taxAmount: invoice.taxAmount,
    totalAmount: invoice.totalAmount,
    amountDue: invoice.amountDue,
    amountDueCurrency: invoice.amountDueCurrency,
    lineItems: lineItemsToJson(invoice.lineItems),
    bankDetails: bankDetailsToJson(invoice.bankDetails),
    notes: invoice.notes,
  };
}
