import { isDeepStrictEqual } from 'node:util';
import { EDITABLE_FIELDS, type EditableField, type UpdateInvoiceRequest } from '@camex/shared';
import { type Invoice, Prisma } from '../../generated/prisma/client.js';
import {
  bankDetailsFromJson,
  bankDetailsToJson,
  fromDateColumn,
  fromDecimalColumn,
  lineItemsFromJson,
  lineItemsToJson,
  toDateColumn,
} from '../invoice-columns.js';

// PATCH /api/invoices/:id (T06 §2): which fields an edit changes, in the domain shape the API
// shows them in, and the columns that changes them.

/** Every editable field with its value (the request's values, already normalized). */
export type EditValues = Required<Omit<UpdateInvoiceRequest, 'version'>>;

/** The editable fields of a row as GET /api/invoices/:id renders them. */
export function editableValues(row: Invoice): EditValues {
  return {
    documentType: row.documentType,
    vendorName: row.vendorName,
    vendorTaxId: row.vendorTaxId,
    billToName: row.billToName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: fromDateColumn(row.invoiceDate),
    serviceDate: fromDateColumn(row.serviceDate),
    dueDate: fromDateColumn(row.dueDate),
    paymentTermsText: row.paymentTermsText,
    paymentTermsDays: row.paymentTermsDays,
    disputeWindowDays: row.disputeWindowDays,
    category: row.category,
    description: row.description,
    airportIcao: row.airportIcao,
    airportIata: row.airportIata,
    locationText: row.locationText,
    aircraftRegistration: row.aircraftRegistration,
    flightNumbers: row.flightNumbers,
    currency: row.currency,
    subtotalAmount: fromDecimalColumn(row.subtotalAmount),
    taxAmount: fromDecimalColumn(row.taxAmount),
    totalAmount: fromDecimalColumn(row.totalAmount),
    amountDue: fromDecimalColumn(row.amountDue),
    amountDueCurrency: row.amountDueCurrency,
    lineItems: lineItemsFromJson(row.lineItems),
    bankDetails: bankDetailsFromJson(row.bankDetails),
    notes: row.notes,
  };
}

type Columns = Prisma.InvoiceUncheckedUpdateInput;

/** The columns one field writes to. */
const COLUMNS: { [K in EditableField]: (value: EditValues[K]) => Columns } = {
  documentType: (documentType) => ({ documentType }),
  vendorName: (vendorName) => ({ vendorName }),
  vendorTaxId: (vendorTaxId) => ({ vendorTaxId }),
  billToName: (billToName) => ({ billToName }),
  invoiceNumber: (invoiceNumber) => ({ invoiceNumber }),
  invoiceDate: (value) => ({ invoiceDate: toDateColumn(value) }),
  serviceDate: (value) => ({ serviceDate: toDateColumn(value) }),
  // SPEC §7: a date someone entered is never re-derived; clearing it lets derivation take over.
  dueDate: (value) => ({
    dueDate: toDateColumn(value),
    dueDateSource: value === null ? null : 'manual',
  }),
  paymentTermsText: (paymentTermsText) => ({ paymentTermsText }),
  paymentTermsDays: (paymentTermsDays) => ({ paymentTermsDays }),
  disputeWindowDays: (disputeWindowDays) => ({ disputeWindowDays }),
  category: (category) => ({ category }),
  description: (description) => ({ description }),
  airportIcao: (airportIcao) => ({ airportIcao }),
  airportIata: (airportIata) => ({ airportIata }),
  locationText: (locationText) => ({ locationText }),
  aircraftRegistration: (aircraftRegistration) => ({ aircraftRegistration }),
  flightNumbers: (flightNumbers) => ({ flightNumbers }),
  currency: (currency) => ({ currency }),
  // Prisma takes decimal strings as they are: no float on the way to `numeric`.
  subtotalAmount: (subtotalAmount) => ({ subtotalAmount }),
  taxAmount: (taxAmount) => ({ taxAmount }),
  totalAmount: (totalAmount) => ({ totalAmount }),
  amountDue: (amountDue) => ({ amountDue }),
  amountDueCurrency: (amountDueCurrency) => ({ amountDueCurrency }),
  lineItems: (value) => ({ lineItems: lineItemsToJson(value) }),
  bankDetails: (value) => ({ bankDetails: bankDetailsToJson(value) }),
  notes: (notes) => ({ notes }),
};

const DECIMAL_FIELDS: ReadonlySet<EditableField> = new Set([
  'subtotalAmount',
  'taxAmount',
  'totalAmount',
  'amountDue',
]);

/** A numeric column's value as the API shows it after the write ("6416.290" → "6416.29"). */
function canonical(field: EditableField, value: unknown): unknown {
  return DECIMAL_FIELDS.has(field) && typeof value === 'string'
    ? new Prisma.Decimal(value).toFixed()
    : value;
}

export interface Edit {
  /** `edited` event data: `{ field: { from, to } }`, changed fields only. */
  event: Record<string, { from: unknown; to: unknown }>;
  columns: Columns;
  changed: EditableField[];
}

function columnsFor<K extends EditableField>(field: K, value: EditValues[K]): Columns {
  return COLUMNS[field](value);
}

/** The fields of `request` that differ from `current` (amounts compared as numbers). */
export function diffEdit(current: EditValues, request: UpdateInvoiceRequest): Edit {
  const edit: Edit = { event: {}, columns: {}, changed: [] };
  for (const field of EDITABLE_FIELDS) {
    const next = request[field];
    if (next === undefined) continue;
    const from = current[field];
    const to = canonical(field, next);
    if (isDeepStrictEqual(from, to)) continue;
    edit.event[field] = { from, to };
    Object.assign(edit.columns, columnsFor(field, next));
    edit.changed.push(field);
  }
  return edit;
}
