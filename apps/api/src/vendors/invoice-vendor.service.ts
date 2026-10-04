import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { type InvoiceDetail, type LinkInvoiceVendorRequest, vendorKey } from '@camex/shared';
import { InvoiceEvaluator } from '../evaluation/invoice-evaluator.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { lockForAction } from '../invoices/workflow/workflow-guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { trustInvoiceBankDetails } from './trust-bank-details.js';
import { assertUnique, lockVendors, vendorIdentitySelect, vendorKeys } from './vendor-rules.js';
import { VendorsService } from './vendors.service.js';

/** The two vendor actions taken from an invoice: link a vendor, trust its bank details. */
@Injectable()
export class InvoiceVendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: InvoiceEvaluator,
    private readonly vendors: VendorsService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Links an existing or new vendor (needs_review only). The extracted vendor name becomes an
   * alias unless the vendor already answers to it or another vendor owns it, so the next invoice
   * matches by itself. A human write on the invoice: checks and increments its version (T06).
   */
  async link(
    invoiceId: string,
    body: LinkInvoiceVendorRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      await lockForAction(tx, invoiceId, 'linkVendor', body.version);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { vendorName: true },
      });

      const vendors = await tx.vendor.findMany({ select: vendorIdentitySelect });
      let vendor;
      if ('vendorId' in body) {
        vendor = vendors.find((v) => v.id === body.vendorId);
        if (!vendor) throw new NotFoundException('Vendor not found');
      } else {
        assertUnique(vendors, [{ value: body.create.name, field: 'create.name' }], []);
        vendor = await tx.vendor.create({
          data: {
            name: body.create.name,
            defaultPaymentTermsDays: body.create.defaultPaymentTermsDays ?? null,
          },
          select: vendorIdentitySelect,
        });
      }

      // Only when it would be unique: a name another vendor owns stays theirs (it is why the
      // invoice matched them), and the link itself still goes through.
      const extractedName = invoice.vendorName;
      const nameKey = extractedName === null ? '' : vendorKey(extractedName);
      const linkedId = vendor.id;
      const addAlias =
        extractedName !== null &&
        nameKey !== '' &&
        !vendors.some((v) => v.id !== linkedId && vendorKeys(v).includes(nameKey)) &&
        !vendorKeys(vendor).includes(nameKey);
      if (addAlias) {
        await tx.vendor.update({
          where: { id: vendor.id },
          data: { aliases: { push: extractedName } },
        });
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { vendorId: vendor.id, version: { increment: 1 } },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          userId,
          type: 'vendor_linked',
          data: { vendorId: vendor.id, method: 'manual' },
        },
      });
      return { vendorId: vendor.id, created: !('vendorId' in body), aliasAdded: addAlias };
    });

    if (result.created) this.vendors.logAction(userId, result.vendorId, 'vendor_created');
    this.vendors.logAction(userId, result.vendorId, 'invoice_vendor_linked');
    await this.evaluator.tryEvaluateWithRelated(invoiceId);
    // A new vendor or alias can match other pending invoices too.
    if (result.created || result.aliasAdded) {
      await this.evaluator.reevaluateVendor(result.vendorId, { rematch: true });
    }
    return this.invoices.get(invoiceId);
  }

  /**
   * Adds the invoice's bank details to its vendor's trusted accounts (needs_review or unpaid).
   * An active account with the same key already counts: nothing changes. `version` makes sure
   * the details trusted are the ones the person saw; it is incremented when an account is added.
   */
  async trustBankDetails(
    invoiceId: string,
    version: number,
    userId: string,
  ): Promise<InvoiceDetail> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      await lockForAction(tx, invoiceId, 'trustBankDetails', version);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { vendorId: true, bankDetails: true },
      });
      if (invoice.vendorId === null) {
        throw new ConflictException(
          'Link the invoice to a vendor before trusting its bank details',
        );
      }
      const { added } = await trustInvoiceBankDetails(tx, {
        invoiceId,
        vendorId: invoice.vendorId,
        bankDetails: invoice.bankDetails,
        userId,
      });
      if (added) {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { version: { increment: 1 } },
        });
      }
      return { vendorId: invoice.vendorId, added };
    });

    if (result.added) {
      this.vendors.logAction(userId, result.vendorId, 'bank_account_trusted');
      await this.evaluator.reevaluateVendor(result.vendorId, { rematch: false });
    }
    return this.invoices.get(invoiceId);
  }
}
