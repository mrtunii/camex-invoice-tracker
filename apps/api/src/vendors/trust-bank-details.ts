import { ConflictException } from '@nestjs/common';
import { bankAccountKey } from '@camex/shared';
import type { Tx } from '../evaluation/invoice-evaluator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bankDetailsFromJson } from '../invoices/invoice-columns.js';
import {
  bankAccountsToJson,
  parseBankAccounts,
  storedAccountKey,
  trustedAccountFrom,
} from './bank-accounts.js';

/**
 * Adds an invoice's bank details to its vendor's trusted accounts (SPEC §9), with a
 * `bank_account_trusted` event (ids only: account numbers never go into event data). An active
 * account with the same key already counts: nothing changes. Used by POST …/trust-bank-details
 * and by approve with `trustBankDetails`. The caller holds lockVendors(tx): bank accounts are a
 * read-modify-write of jsonb.
 */
export async function trustInvoiceBankDetails(
  tx: Tx,
  input: {
    invoiceId: string;
    vendorId: string;
    bankDetails: Prisma.JsonValue | null;
    userId: string;
  },
): Promise<{ added: boolean }> {
  const details = bankDetailsFromJson(input.bankDetails);
  const key = bankAccountKey(details);
  if (details === null || key === null) {
    throw new ConflictException('The invoice has no IBAN or account number to trust');
  }

  const vendor = await tx.vendor.findUniqueOrThrow({
    where: { id: input.vendorId },
    select: { bankAccounts: true },
  });
  const accounts = parseBankAccounts(vendor.bankAccounts);
  if (accounts.some((a) => a.removed_at === null && storedAccountKey(a) === key)) {
    return { added: false };
  }

  const account = trustedAccountFrom(details, {
    invoiceId: input.invoiceId,
    userId: input.userId,
    at: new Date(),
  });
  await tx.vendor.update({
    where: { id: input.vendorId },
    data: { bankAccounts: bankAccountsToJson([...accounts, account]) },
  });
  await tx.invoiceEvent.create({
    data: {
      invoiceId: input.invoiceId,
      userId: input.userId,
      type: 'bank_account_trusted',
      data: { vendorId: input.vendorId, accountId: account.id },
    },
  });
  return { added: true };
}
