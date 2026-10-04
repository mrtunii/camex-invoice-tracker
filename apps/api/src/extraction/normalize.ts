import {
  type BankDetails,
  type ExtractedInvoice,
  type ExtractedLineItem,
  type ExtractionOutputV1,
  aircraftRegistration,
  bankDetails as normalizeBankDetails,
  calendarDate,
  currencyCode,
  dayCount,
  decimal,
  flightNumbers,
  iataCode,
  icaoCode,
  name,
  taxId,
  text,
} from '@camex/shared';

// Wire → domain (T03 §5). Pure functions: the worker and the eval run the same code. Anything
// that doesn't survive its rule becomes null, so review sees an empty field, never a guess.
// The field rules live in @camex/shared: edits (T06) normalize with the same ones.

export {
  aircraftRegistration,
  calendarDate,
  currencyCode,
  dayCount,
  decimal,
  flightNumbers,
  iataCode,
  icaoCode,
  name,
  taxId,
  text,
};

function lineItem(line: ExtractionOutputV1['lineItems'][number]): ExtractedLineItem {
  return {
    kind: line.kind,
    description: text(line.description),
    quantity: decimal(line.quantity),
    uom: text(line.uom),
    unitPrice: decimal(line.unitPrice),
    amount: decimal(line.amount),
  };
}

/** Null when nothing is left; an account number that is just the IBAN again is dropped. */
export function bankDetails(details: ExtractionOutputV1['bankDetails']): BankDetails | null {
  return normalizeBankDetails(details);
}

export function normalizeExtraction(raw: ExtractionOutputV1): ExtractedInvoice {
  return {
    documentType: raw.documentType,
    vendorName: name(raw.vendorName),
    vendorTaxId: taxId(raw.vendorTaxId),
    billToName: name(raw.billToName),
    invoiceNumber: text(raw.invoiceNumber),
    invoiceDate: calendarDate(raw.invoiceDate),
    serviceDate: calendarDate(raw.serviceDate),
    dueDate: calendarDate(raw.dueDate),
    paymentTermsText: text(raw.paymentTermsText),
    paymentTermsDays: dayCount(raw.paymentTermsDays),
    disputeWindowDays: dayCount(raw.disputeWindowDays),
    category: raw.category,
    description: text(raw.description),
    airportIcao: icaoCode(raw.airportIcao),
    airportIata: iataCode(raw.airportIata),
    locationText: text(raw.locationText),
    aircraftRegistration: aircraftRegistration(raw.aircraftRegistration),
    flightNumbers: flightNumbers(raw.flightNumbers),
    currency: currencyCode(raw.currency),
    subtotalAmount: decimal(raw.subtotalAmount),
    taxAmount: decimal(raw.taxAmount),
    totalAmount: decimal(raw.totalAmount),
    amountDue: decimal(raw.amountDue),
    amountDueCurrency: currencyCode(raw.amountDueCurrency),
    lineItems: raw.lineItems.map(lineItem),
    bankDetails: bankDetails(raw.bankDetails),
    notes: text(raw.notes),
  };
}
