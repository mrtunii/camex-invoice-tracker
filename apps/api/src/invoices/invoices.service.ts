import { Injectable, NotFoundException } from '@nestjs/common';
import { type InvoiceDetail, invoiceFlagSchema } from '@camex/shared';
import { z } from 'zod';
import type { Invoice } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bankDetailsFromJson,
  fromDateColumn,
  fromDecimalColumn,
  lineItemsFromJson,
} from './invoice-columns.js';

/** Row → API DTO: camelCase, decimals as strings, dates 'YYYY-MM-DD', no raw model output. */
export function toInvoiceDetail(row: Invoice): InvoiceDetail {
  return {
    id: row.id,
    inboundEmailId: row.inboundEmailId,
    fileName: row.fileName,
    fileSize: row.fileSize,
    fileSha256: row.fileSha256,
    pageCount: row.pageCount,
    status: row.status,

    extractionStatus: row.extractionStatus,
    extractionError: row.extractionError,
    extractionModel: row.extractionModel,
    extractionPromptVersion: row.extractionPromptVersion,
    extractedAt: row.extractedAt?.toISOString() ?? null,

    documentType: row.documentType,
    vendorId: row.vendorId,
    vendorName: row.vendorName,
    vendorTaxId: row.vendorTaxId,
    billToName: row.billToName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: fromDateColumn(row.invoiceDate),
    serviceDate: fromDateColumn(row.serviceDate),
    dueDate: fromDateColumn(row.dueDate),
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

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(id: string): Promise<InvoiceDetail> {
    const row = await this.prisma.invoice.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Invoice not found');
    return toInvoiceDetail(row);
  }
}
