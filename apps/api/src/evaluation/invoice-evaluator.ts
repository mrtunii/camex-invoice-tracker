import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type Clock,
  type InvoiceFlag,
  businessToday,
  invoiceNumberKey,
  vendorKey,
} from '@camex/shared';
import { CLOCK } from '../clock/clock.module.js';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  bankDetailsFromJson,
  fromDateColumn,
  fromDecimalColumn,
  lineItemsFromJson,
  toDateColumn,
} from '../invoices/invoice-columns.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeAccountKeys, parseBankAccounts } from '../vendors/bank-accounts.js';
import { deriveDates } from './derive-dates.js';
import { emailDomain, isOwnDomain, vendorForDomain } from './email-domains.js';
import { type DuplicateCandidate, type FlagInvoice, computeFlags } from './flags.js';

export type Tx = Prisma.TransactionClient;

/** How an automatic vendor link was made (`vendor_linked` event data). */
export type MatchMethod = 'name' | 'alias' | 'email_domain';

export interface EvaluationResult {
  /** Whether vendor, dates or flags were written. */
  changed: boolean;
  linked: MatchMethod | null;
  flags: InvoiceFlag[];
}

const OPEN_STATUSES = ['needs_review', 'unpaid'] as const;

/**
 * The characters JS `\s` matches, as a Postgres regex class (`[[:space:]]` alone misses the
 * no-break and other Unicode spaces).
 */
const JS_WHITESPACE = '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';

const evaluationSelect = {
  id: true,
  status: true,
  extractionStatus: true,
  documentType: true,
  vendorId: true,
  vendorName: true,
  billToName: true,
  invoiceNumber: true,
  invoiceDate: true,
  serviceDate: true,
  dueDate: true,
  dueDateSource: true,
  paymentTermsDays: true,
  disputeWindowDays: true,
  disputeDeadline: true,
  currency: true,
  totalAmount: true,
  taxAmount: true,
  amountDue: true,
  amountDueCurrency: true,
  lineItems: true,
  bankDetails: true,
  fileSha256: true,
  flags: true,
  inboundEmail: { select: { provider: true, fromAddress: true } },
} satisfies Prisma.InvoiceSelect;

type EvaluationRow = Prisma.InvoiceGetPayload<{ select: typeof evaluationSelect }>;

const duplicateSelect = {
  id: true,
  status: true,
  fileSha256: true,
  invoiceNumber: true,
  vendorId: true,
  vendorName: true,
} satisfies Prisma.InvoiceSelect;

/**
 * Brings an invoice's derived state up to date (T04 §6): vendor match, derived dates, flags.
 * Every trigger goes through here: extraction, vendor changes, the daily run, and T06's edits.
 */
@Injectable()
export class InvoiceEvaluator {
  private readonly logger = new Logger(InvoiceEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The business day (Asia/Tbilisi) by the injected clock. */
  today(): string {
    return businessToday(this.clock);
  }

  /**
   * Evaluates one invoice inside `tx`: (1) vendor match when unlinked and in needs_review,
   * (2) derived dates, (3) flags, (4) writes vendor_id, the dates and flags if anything changed.
   * Returns null for an unknown id.
   */
  async evaluate(tx: Tx, invoiceId: string, today: string): Promise<EvaluationResult | null> {
    // Serializes evaluations (and the extraction write) of one invoice, and makes the read
    // below see the latest committed row.
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    const row = await tx.invoice.findUnique({ where: { id: invoiceId }, select: evaluationSelect });
    if (!row) return null;

    let vendorId = row.vendorId;
    let linked: MatchMethod | null = null;
    if (vendorId === null && row.status === 'needs_review') {
      const match = await this.matchVendor(tx, row);
      if (match) {
        vendorId = match.vendorId;
        linked = match.method;
      }
    }

    const vendor =
      vendorId === null
        ? null
        : await tx.vendor.findUniqueOrThrow({
            where: { id: vendorId },
            select: { defaultPaymentTermsDays: true, bankAccounts: true },
          });

    const invoice = flagInvoice(row, vendorId);
    const dates = deriveDates(
      { ...invoice, disputeWindowDays: row.disputeWindowDays },
      vendor && { defaultPaymentTermsDays: vendor.defaultPaymentTermsDays },
    );
    const flags = computeFlags(
      {
        invoice: { ...invoice, ...dates },
        vendor: vendor && {
          trustedAccountKeys: activeAccountKeys(parseBankAccounts(vendor.bankAccounts)),
        },
        candidates: await this.duplicateCandidates(tx, row),
      },
      today,
    );

    const changed =
      vendorId !== row.vendorId ||
      dates.dueDate !== invoice.dueDate ||
      dates.dueDateSource !== row.dueDateSource ||
      dates.disputeDeadline !== invoice.disputeDeadline ||
      !isDeepStrictEqual(flags, row.flags);
    // Skipping no-op writes keeps updated_at meaningful (the recovery sweep relies on it).
    if (changed) {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          vendorId,
          dueDate: toDateColumn(dates.dueDate),
          dueDateSource: dates.dueDateSource,
          disputeDeadline: toDateColumn(dates.disputeDeadline),
          flags,
        },
      });
    }
    if (linked !== null) {
      await tx.invoiceEvent.create({
        data: { invoiceId, type: 'vendor_linked', data: { vendorId, method: linked } },
      });
    }
    return { changed, linked, flags };
  }

  /**
   * Run after the caller's commit: evaluates the invoice, then every other invoice sharing its
   * file hash or invoice number, each in its own transaction. Whichever of two concurrent
   * duplicates commits last re-flags the other, so duplicates converge.
   */
  async evaluateWithRelated(invoiceId: string): Promise<void> {
    const today = this.today();
    await this.prisma.$transaction((tx) => this.evaluate(tx, invoiceId, today));
    const row = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { fileSha256: true, invoiceNumber: true },
    });
    if (!row) return;
    for (const id of await this.relatedIds(this.prisma, invoiceId, row)) {
      await this.prisma.$transaction((tx) => this.evaluate(tx, id, today));
    }
  }

  /**
   * evaluateWithRelated for triggers whose own write is already committed (extraction, vendor
   * changes): a failure is logged, not thrown. The daily run or the next change catches up.
   */
  async tryEvaluateWithRelated(invoiceId: string): Promise<void> {
    try {
      await this.evaluateWithRelated(invoiceId);
    } catch (error) {
      this.logger.error(
        { invoiceId, err: error instanceof Error ? error.message : String(error) },
        'invoice evaluation failed',
      );
    }
  }

  /**
   * After a vendor change: re-evaluates the vendor's needs_review and unpaid invoices, and with
   * `rematch` (vendor created, or name, aliases or domains changed) every unlinked needs_review
   * invoice too, so new matches link.
   */
  async reevaluateVendor(vendorId: string, { rematch }: { rematch: boolean }): Promise<void> {
    let ids: string[];
    try {
      const rows = await this.prisma.invoice.findMany({
        where: {
          OR: [
            { vendorId, status: { in: [...OPEN_STATUSES] } },
            ...(rematch ? [{ vendorId: null, status: 'needs_review' as const }] : []),
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      ids = rows.map((row) => row.id);
    } catch (error) {
      // The vendor change is committed; the daily run catches up.
      this.logger.error(
        { vendorId, err: error instanceof Error ? error.message : String(error) },
        'vendor re-evaluation failed',
      );
      return;
    }
    for (const id of ids) await this.tryEvaluateWithRelated(id);
  }

  /** Daily (00:05 Tbilisi): every needs_review and unpaid invoice, for the date-based flags. */
  async reevaluateOpen(): Promise<{ evaluated: number; changed: number; failed: number }> {
    const today = this.today();
    const rows = await this.prisma.invoice.findMany({
      where: { status: { in: [...OPEN_STATUSES] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    let changed = 0;
    let failed = 0;
    for (const { id } of rows) {
      try {
        const result = await this.prisma.$transaction((tx) => this.evaluate(tx, id, today));
        if (result?.changed) changed++;
      } catch (error) {
        failed++;
        this.logger.error(
          { invoiceId: id, err: error instanceof Error ? error.message : String(error) },
          'invoice evaluation failed',
        );
      }
    }
    return { evaluated: rows.length, changed, failed };
  }

  /**
   * SPEC §9 order: vendorKey(vendor_name) against names and aliases; else the sender's domain
   * (Mailgun only, never one of ours) against email_domains, subdomains included. Keys are unique
   * across vendors, so at most one vendor matches by name; by domain the most specific wins.
   */
  private async matchVendor(
    tx: Tx,
    row: EvaluationRow,
  ): Promise<{ vendorId: string; method: MatchMethod } | null> {
    const vendors = await tx.vendor.findMany({
      select: { id: true, name: true, aliases: true, emailDomains: true },
    });

    const key = row.vendorName === null ? '' : vendorKey(row.vendorName);
    if (key !== '') {
      for (const vendor of vendors) {
        if (vendorKey(vendor.name) === key) return { vendorId: vendor.id, method: 'name' };
        if (vendor.aliases.some((alias) => vendorKey(alias) === key)) {
          return { vendorId: vendor.id, method: 'alias' };
        }
      }
    }

    if (row.inboundEmail.provider !== 'mailgun') return null;
    const domain = emailDomain(row.inboundEmail.fromAddress);
    if (domain === null || isOwnDomain(domain, this.env.OWN_EMAIL_DOMAINS)) return null;
    const byDomain = vendorForDomain(domain, vendors);
    return byDomain ? { vendorId: byDomain.id, method: 'email_domain' } : null;
  }

  private async duplicateCandidates(tx: Tx, row: EvaluationRow): Promise<DuplicateCandidate[]> {
    const ids = await this.relatedIds(tx, row.id, row);
    if (ids.length === 0) return [];
    return tx.invoice.findMany({ where: { id: { in: ids } }, select: duplicateSelect });
  }

  /** Other invoices (any status) with the same file hash or the same invoice number key. */
  private async relatedIds(
    db: Pick<Tx, '$queryRaw'>,
    invoiceId: string,
    { fileSha256, invoiceNumber }: { fileSha256: string; invoiceNumber: string | null },
  ): Promise<string[]> {
    const numberKey = invoiceNumber === null ? '' : invoiceNumberKey(invoiceNumber);
    // invoiceNumberKey() in SQL: uppercase, whitespace removed. The flag rules re-check every
    // candidate with the JS key, so this only has to find them.
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM invoices
      WHERE id <> ${invoiceId}::uuid
        AND (
          file_sha256 = ${fileSha256}
          OR (${numberKey} <> '' AND upper(regexp_replace(invoice_number, ${JS_WHITESPACE}, '', 'g')) = ${numberKey})
        )
      ORDER BY created_at, id`;
    return rows.map((r) => r.id);
  }
}

/** Row → the fields the flag rules read (dates as 'YYYY-MM-DD', decimals as strings). */
function flagInvoice(row: EvaluationRow, vendorId: string | null): FlagInvoice {
  return {
    id: row.id,
    status: row.status,
    extractionStatus: row.extractionStatus,
    documentType: row.documentType,
    vendorId,
    vendorName: row.vendorName,
    billToName: row.billToName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: fromDateColumn(row.invoiceDate),
    serviceDate: fromDateColumn(row.serviceDate),
    dueDate: fromDateColumn(row.dueDate),
    dueDateSource: row.dueDateSource,
    paymentTermsDays: row.paymentTermsDays,
    disputeDeadline: fromDateColumn(row.disputeDeadline),
    currency: row.currency,
    totalAmount: fromDecimalColumn(row.totalAmount),
    taxAmount: fromDecimalColumn(row.taxAmount),
    amountDue: fromDecimalColumn(row.amountDue),
    amountDueCurrency: row.amountDueCurrency,
    lineItems: lineItemsFromJson(row.lineItems),
    bankDetails: bankDetailsFromJson(row.bankDetails),
    fileSha256: row.fileSha256,
  };
}
