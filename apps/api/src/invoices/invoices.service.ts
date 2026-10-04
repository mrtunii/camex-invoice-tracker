import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type ExtractedInvoice,
  type InvoiceDetail,
  type InvoiceEvent,
  type InvoiceSourceEmail,
  extractionOutputV1Schema,
  invoiceFlagSchema,
} from '@camex/shared';
import { z } from 'zod';
import { normalizeExtraction } from '../extraction/normalize.js';
import type { Prisma } from '../generated/prisma/client.js';
import { attachmentsFromJson } from '../inbox/stored-attachments.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bankDetailsFromJson,
  fromDateColumn,
  fromDecimalColumn,
  lineItemsFromJson,
} from './invoice-columns.js';

const namedRef = { select: { id: true, name: true } } as const;

/** What GET /api/invoices/:id reads besides the invoice's own columns. */
export const invoiceDetailInclude = {
  vendor: namedRef,
  approvedBy: namedRef,
  paidBy: namedRef,
  rejectedBy: namedRef,
  inboundEmail: {
    select: {
      id: true,
      provider: true,
      fromAddress: true,
      subject: true,
      receivedAt: true,
      attachments: true,
      uploadedBy: namedRef,
    },
  },
} satisfies Prisma.InvoiceInclude;

export type InvoiceDetailRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceDetailInclude }>;

/** The model's reading (T06): only for a succeeded extraction whose raw output still parses. */
function extractedFrom(row: InvoiceDetailRow): ExtractedInvoice | null {
  if (row.extractionStatus !== 'succeeded') return null;
  const raw = extractionOutputV1Schema.safeParse(row.extractionRaw);
  return raw.success ? normalizeExtraction(raw.data) : null;
}

function sourceEmail(email: InvoiceDetailRow['inboundEmail']): InvoiceSourceEmail {
  return {
    id: email.id,
    provider: email.provider,
    fromAddress: email.fromAddress,
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
    uploadedBy: email.uploadedBy,
    ignoredAttachments: (attachmentsFromJson(email.attachments) ?? [])
      .filter((attachment) => !attachment.processed)
      .map(({ filename, contentType, size }) => ({ filename, contentType, size })),
  };
}

/** Row → API DTO: camelCase, decimals as strings, dates 'YYYY-MM-DD', no raw model output. */
export function toInvoiceDetail(row: InvoiceDetailRow): InvoiceDetail {
  return {
    id: row.id,
    inboundEmailId: row.inboundEmailId,
    fileName: row.fileName,
    fileSize: row.fileSize,
    fileSha256: row.fileSha256,
    pageCount: row.pageCount,
    status: row.status,
    version: row.version,

    extractionStatus: row.extractionStatus,
    extractionError: row.extractionError,
    extractionModel: row.extractionModel,
    extractionPromptVersion: row.extractionPromptVersion,
    extractedAt: row.extractedAt?.toISOString() ?? null,
    extracted: extractedFrom(row),

    documentType: row.documentType,
    vendorId: row.vendorId,
    vendor: row.vendor,
    vendorName: row.vendorName,
    vendorTaxId: row.vendorTaxId,
    billToName: row.billToName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: fromDateColumn(row.invoiceDate),
    serviceDate: fromDateColumn(row.serviceDate),
    dueDate: fromDateColumn(row.dueDate),
    dueDateSource: row.dueDateSource,
    disputeDeadline: fromDateColumn(row.disputeDeadline),
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
    flags: z.array(invoiceFlagSchema).parse(row.flags),

    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    paidAt: fromDateColumn(row.paidAt),
    paidBy: row.paidBy,
    paymentReference: row.paymentReference,
    paymentNote: row.paymentNote,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedBy: row.rejectedBy,
    rejectionReason: row.rejectionReason,
    rejectionNote: row.rejectionNote,

    email: sourceEmail(row.inboundEmail),

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const eventVendorSchema = z.object({ vendorId: z.uuid() });

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(id: string): Promise<InvoiceDetail> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      include: invoiceDetailInclude,
    });
    if (!row) throw new NotFoundException('Invoice not found');
    return toInvoiceDetail(row);
  }

  /** The activity log (GET /api/invoices/:id/events): newest first, with user and vendor names. */
  async events(id: string): Promise<InvoiceEvent[]> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { id: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const rows = await this.prisma.invoiceEvent.findMany({
      where: { invoiceId: id },
      include: { user: namedRef },
      // clock_timestamp() defaults keep events of one transaction in order; id breaks exact ties.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const vendorIdOf = (data: Prisma.JsonValue) => {
      const parsed = eventVendorSchema.safeParse(data);
      return parsed.success ? parsed.data.vendorId : null;
    };
    const vendorIds = [
      ...new Set(rows.map((row) => vendorIdOf(row.data)).filter((v) => v !== null)),
    ];
    const vendors =
      vendorIds.length === 0
        ? []
        : await this.prisma.vendor.findMany({ where: { id: { in: vendorIds } }, ...namedRef });

    return rows.map((row) => {
      const vendorId = vendorIdOf(row.data);
      const data = z.record(z.string(), z.unknown()).safeParse(row.data);
      if (!data.success) {
        this.logger.warn({ eventId: row.id }, 'event data is not an object');
      }
      return {
        id: row.id,
        type: row.type,
        at: row.createdAt.toISOString(),
        user: row.user,
        vendor: vendors.find((vendor) => vendor.id === vendorId) ?? null,
        data: data.success ? data.data : {},
      };
    });
  }
}
