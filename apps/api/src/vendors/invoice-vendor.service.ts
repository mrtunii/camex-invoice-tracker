import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type InvoiceDetail,
  type LinkInvoiceVendorRequest,
  bankAccountKey,
  vendorKey,
} from '@camex/shared';
import { InvoiceEvaluator, type Tx } from '../evaluation/invoice-evaluator.js';
import { bankDetailsFromJson } from '../invoices/invoice-columns.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bankAccountsToJson,
  parseBankAccounts,
  storedAccountKey,
  trustedAccountFrom,
} from './bank-accounts.js';
import { assertUnique, lockVendors, vendorIdentitySelect, vendorKeys } from './vendor-rules.js';
import { VendorsService } from './vendors.service.js';

async function lockInvoice(tx: Tx, invoiceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
}

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
   * matches by itself.
   */
  async link(
    invoiceId: string,
    body: LinkInvoiceVendorRequest,
    userId: string,
  ): Promise<InvoiceDetail> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      await lockInvoice(tx, invoiceId);
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { status: true, vendorName: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'needs_review') {
        throw new ConflictException('A vendor can only be linked while the invoice needs review');
      }

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

      await tx.invoice.update({ where: { id: invoiceId }, data: { vendorId: vendor.id } });
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
   * An active account with the same key already counts: nothing changes.
   */
  async trustBankDetails(invoiceId: string, userId: string): Promise<InvoiceDetail> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      await lockInvoice(tx, invoiceId);
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { status: true, vendorId: true, bankDetails: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'needs_review' && invoice.status !== 'unpaid') {
        throw new ConflictException(
          'Bank details can only be trusted on an invoice that needs review or is unpaid',
        );
      }
      if (invoice.vendorId === null) {
        throw new ConflictException(
          'Link the invoice to a vendor before trusting its bank details',
        );
      }
      const details = bankDetailsFromJson(invoice.bankDetails);
      const key = bankAccountKey(details);
      if (details === null || key === null) {
        throw new ConflictException('The invoice has no IBAN or account number to trust');
      }

      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: invoice.vendorId },
        select: { bankAccounts: true },
      });
      const accounts = parseBankAccounts(vendor.bankAccounts);
      const existing = accounts.find((a) => a.removed_at === null && storedAccountKey(a) === key);
      if (existing) return { vendorId: invoice.vendorId, added: false };

      const account = trustedAccountFrom(details, { invoiceId, userId, at: new Date() });
      await tx.vendor.update({
        where: { id: invoice.vendorId },
        data: { bankAccounts: bankAccountsToJson([...accounts, account]) },
      });
      // Ids only: account numbers never go into event data.
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          userId,
          type: 'bank_account_trusted',
          data: { vendorId: invoice.vendorId, accountId: account.id },
        },
      });
      return { vendorId: invoice.vendorId, added: true };
    });

    if (result.added) {
      this.vendors.logAction(userId, result.vendorId, 'bank_account_trusted');
      await this.evaluator.reevaluateVendor(result.vendorId, { rematch: false });
    }
    return this.invoices.get(invoiceId);
  }
}
