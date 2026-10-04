import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CreateVendorRequest,
  NamedRef,
  UpdateVendorRequest,
  VendorDetail,
  VendorListQuery,
  VendorSummary,
} from '@camex/shared';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { InvoiceEvaluator } from '../evaluation/invoice-evaluator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeAccountKeys, bankAccountsToJson, parseBankAccounts } from './bank-accounts.js';
import {
  assertNotOwnDomains,
  assertUnique,
  lockVendors,
  requestedDomains,
  requestedNames,
  vendorIdentitySelect,
  withoutRepeats,
} from './vendor-rules.js';

const OPEN_STATUSES = ['needs_review', 'unpaid'] as const;

const vendorSelect = {
  ...vendorIdentitySelect,
  defaultPaymentTermsDays: true,
  bankAccounts: true,
} satisfies Prisma.VendorSelect;

type VendorRow = Prisma.VendorGetPayload<{ select: typeof vendorSelect }>;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The vendor registry (SPEC §9). Every change re-evaluates the invoices it can affect. */
@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: InvoiceEvaluator,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Sorted by name; `search` matches the name, an alias or a domain, case-insensitively. */
  async list({ search }: VendorListQuery): Promise<VendorSummary[]> {
    const rows = await this.prisma.vendor.findMany({ select: vendorSelect });
    const needle = search?.toLowerCase() ?? '';
    const matching = rows.filter((vendor) =>
      [vendor.name, ...vendor.aliases, ...vendor.emailDomains].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    );
    const counts = await this.openInvoiceCounts(matching.map((vendor) => vendor.id));
    return matching
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      .map((vendor) => this.toSummary(vendor, counts));
  }

  async get(id: string): Promise<VendorDetail> {
    const row = await this.prisma.vendor.findUnique({ where: { id }, select: vendorSelect });
    if (!row) throw new NotFoundException('Vendor not found');
    return this.toDetail(row);
  }

  async create(input: CreateVendorRequest, userId: string): Promise<VendorDetail> {
    assertNotOwnDomains(input.emailDomains ?? [], this.env.OWN_EMAIL_DOMAINS);
    const row = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      const others = await tx.vendor.findMany({ select: vendorIdentitySelect });
      assertUnique(others, requestedNames(input), requestedDomains(input));
      return tx.vendor.create({
        data: {
          name: input.name,
          ...withoutRepeats(input.name, input.aliases ?? [], input.emailDomains ?? []),
          defaultPaymentTermsDays: input.defaultPaymentTermsDays ?? null,
        },
        select: { id: true },
      });
    });
    this.logAction(userId, row.id, 'vendor_created');
    await this.evaluator.reevaluateVendor(row.id, { rematch: true });
    return this.get(row.id);
  }

  async update(id: string, input: UpdateVendorRequest, userId: string): Promise<VendorDetail> {
    assertNotOwnDomains(input.emailDomains ?? [], this.env.OWN_EMAIL_DOMAINS);
    const { rematch } = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      const existing = await tx.vendor.findUnique({ where: { id }, select: vendorSelect });
      if (!existing) throw new NotFoundException('Vendor not found');
      const others = await tx.vendor.findMany({
        where: { id: { not: id } },
        select: vendorIdentitySelect,
      });
      assertUnique(others, requestedNames(input), requestedDomains(input));

      const name = input.name ?? existing.name;
      const { aliases, emailDomains } = withoutRepeats(
        name,
        input.aliases ?? existing.aliases,
        input.emailDomains ?? existing.emailDomains,
      );
      await tx.vendor.update({
        where: { id },
        data: {
          name,
          aliases,
          emailDomains,
          ...(input.defaultPaymentTermsDays === undefined
            ? {}
            : { defaultPaymentTermsDays: input.defaultPaymentTermsDays }),
        },
      });
      return {
        rematch:
          name !== existing.name ||
          !sameList(aliases, existing.aliases) ||
          !sameList(emailDomains, existing.emailDomains),
      };
    });
    this.logAction(userId, id, 'vendor_updated');
    await this.evaluator.reevaluateVendor(id, { rematch });
    return this.get(id);
  }

  /** Soft removal: the entry stays (audit trail) but no longer counts. Idempotent. */
  async removeBankAccount(
    vendorId: string,
    accountId: string,
    userId: string,
  ): Promise<VendorDetail> {
    const removed = await this.prisma.$transaction(async (tx) => {
      await lockVendors(tx);
      const vendor = await tx.vendor.findUnique({
        where: { id: vendorId },
        select: { bankAccounts: true },
      });
      if (!vendor) throw new NotFoundException('Vendor not found');
      const accounts = parseBankAccounts(vendor.bankAccounts);
      const account = accounts.find((a) => a.id === accountId);
      if (!account) throw new NotFoundException('Bank account not found');
      if (account.removed_at !== null) return false;

      const removedAt = new Date().toISOString();
      await tx.vendor.update({
        where: { id: vendorId },
        data: {
          bankAccounts: bankAccountsToJson(
            accounts.map((a) =>
              a.id === accountId ? { ...a, removed_at: removedAt, removed_by_id: userId } : a,
            ),
          ),
        },
      });
      return true;
    });
    if (removed) {
      this.logAction(userId, vendorId, 'bank_account_removed');
      await this.evaluator.reevaluateVendor(vendorId, { rematch: false });
    }
    return this.get(vendorId);
  }

  /** Vendor and trust actions log who, which vendor and what, never names or bank details. */
  logAction(userId: string, vendorId: string, action: string): void {
    this.logger.log({ userId, vendorId, action }, 'vendor action');
  }

  private async openInvoiceCounts(vendorIds: string[]): Promise<Map<string, number>> {
    if (vendorIds.length === 0) return new Map();
    const groups = await this.prisma.invoice.groupBy({
      by: ['vendorId'],
      where: { vendorId: { in: vendorIds }, status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(
      groups.flatMap((group) =>
        group.vendorId === null ? [] : [[group.vendorId, group._count._all]],
      ),
    );
  }

  private toSummary(row: VendorRow, openCounts: Map<string, number>): VendorSummary {
    return {
      id: row.id,
      name: row.name,
      aliases: row.aliases,
      emailDomains: row.emailDomains,
      defaultPaymentTermsDays: row.defaultPaymentTermsDays,
      activeBankAccountCount: activeAccountKeys(parseBankAccounts(row.bankAccounts)).length,
      openInvoiceCount: openCounts.get(row.id) ?? 0,
    };
  }

  private async toDetail(row: VendorRow): Promise<VendorDetail> {
    const accounts = parseBankAccounts(row.bankAccounts);
    const userIds = [...new Set(accounts.flatMap((a) => [a.added_by_id, a.removed_by_id]))].filter(
      (id): id is string => id !== null,
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const userRef = (id: string | null): NamedRef | null =>
      users.find((user) => user.id === id) ?? null;

    return {
      ...this.toSummary(row, await this.openInvoiceCounts([row.id])),
      bankAccounts: accounts.map((a) => ({
        id: a.id,
        beneficiary: a.beneficiary,
        bankName: a.bank_name,
        iban: a.iban,
        accountNumber: a.account_number,
        swift: a.swift,
        routingNumber: a.routing_number,
        currency: a.currency,
        addedAt: a.added_at,
        addedBy: userRef(a.added_by_id),
        sourceInvoiceId: a.source_invoice_id,
        removedAt: a.removed_at,
        removedBy: userRef(a.removed_by_id),
      })),
    };
  }
}
