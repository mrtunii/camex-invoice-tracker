import { randomUUID } from 'node:crypto';
import { type BankDetails, bankAccountKey } from '@camex/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

// vendors.bank_accounts jsonb (SPEC §5): snake_case like the columns. Entries are added from an
// invoice and soft-removed (removed_at), never deleted, so the list is also the audit trail.

const storedBankAccountSchema = z.object({
  id: z.uuid(),
  beneficiary: z.string().nullable(),
  bank_name: z.string().nullable(),
  iban: z.string().nullable(),
  account_number: z.string().nullable(),
  swift: z.string().nullable(),
  routing_number: z.string().nullable(),
  currency: z.string().nullable(),
  added_at: z.iso.datetime({ offset: true }),
  added_by_id: z.uuid().nullable(),
  source_invoice_id: z.uuid().nullable(),
  removed_at: z.iso.datetime({ offset: true }).nullable(),
  removed_by_id: z.uuid().nullable(),
});
export type StoredBankAccount = z.infer<typeof storedBankAccountSchema>;

export function parseBankAccounts(value: Prisma.JsonValue): StoredBankAccount[] {
  return z.array(storedBankAccountSchema).parse(value);
}

export function bankAccountsToJson(accounts: readonly StoredBankAccount[]): Prisma.InputJsonValue {
  return accounts.map((account) => ({ ...account }));
}

export function storedAccountKey(account: StoredBankAccount): string | null {
  return bankAccountKey({ iban: account.iban, accountNumber: account.account_number });
}

/** Keys of the accounts that count for matching: the ones not removed. */
export function activeAccountKeys(accounts: readonly StoredBankAccount[]): string[] {
  return accounts.flatMap((account) => {
    const key = account.removed_at === null ? storedAccountKey(account) : null;
    return key === null ? [] : [key];
  });
}

/** A new trusted account copied from an invoice's bank details (`userId` null: no user, e.g. seeded). */
export function trustedAccountFrom(
  details: BankDetails,
  source: { invoiceId: string; userId: string | null; at: Date },
): StoredBankAccount {
  return {
    id: randomUUID(),
    beneficiary: details.beneficiary,
    bank_name: details.bankName,
    iban: details.iban,
    account_number: details.accountNumber,
    swift: details.swift,
    routing_number: details.routingNumber,
    currency: details.currency,
    added_at: source.at.toISOString(),
    added_by_id: source.userId,
    source_invoice_id: source.invoiceId,
    removed_at: null,
    removed_by_id: null,
  };
}
