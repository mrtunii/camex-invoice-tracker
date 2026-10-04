import { BadRequestException, ConflictException } from '@nestjs/common';
import { type VendorConflict, vendorKey } from '@camex/shared';
import { isOwnDomain } from '../evaluation/email-domains.js';
import type { Tx } from '../evaluation/invoice-evaluator.js';

// SPEC §9 vendor identity rules: name and alias keys, and email domains, are unique across
// vendors, so a match by name, alias or domain always finds at most one vendor.

export interface VendorIdentity {
  id: string;
  name: string;
  aliases: readonly string[];
  emailDomains: readonly string[];
}

export const vendorIdentitySelect = {
  id: true,
  name: true,
  aliases: true,
  emailDomains: true,
} as const;

/** A request value with the request path it came from, for 409/400 field errors. */
export interface FieldValue {
  value: string;
  field: string;
}

/**
 * Taken by every vendor write: uniqueness spans all vendors, and bank accounts are a
 * read-modify-write of jsonb. Vendor writes are rare, so one lock is enough.
 */
export async function lockVendors(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('camex:vendors'))`;
}

export function vendorKeys(vendor: Pick<VendorIdentity, 'name' | 'aliases'>): string[] {
  return [vendor.name, ...vendor.aliases].map(vendorKey);
}

export function vendorConflict(
  field: string,
  message: string,
  vendor: Pick<VendorIdentity, 'id' | 'name'>,
): ConflictException {
  const body: VendorConflict & { error: string } = {
    statusCode: 409,
    error: 'Conflict',
    message,
    field,
    vendor: { id: vendor.id, name: vendor.name },
  };
  return new ConflictException(body);
}

/** 409 naming the other vendor for the first name, alias or domain it already uses. */
export function assertUnique(
  others: readonly VendorIdentity[],
  names: readonly FieldValue[],
  domains: readonly FieldValue[],
): void {
  for (const { value, field } of names) {
    const key = vendorKey(value);
    const owner = others.find((vendor) => vendorKeys(vendor).includes(key));
    if (owner) {
      throw vendorConflict(field, `Vendor "${owner.name}" already uses the name "${value}"`, owner);
    }
  }
  for (const { value, field } of domains) {
    const owner = others.find((vendor) => vendor.emailDomains.includes(value));
    if (owner) {
      throw vendorConflict(field, `Vendor "${owner.name}" already uses the domain ${value}`, owner);
    }
  }
}

/** 400 in the ZodValidationPipe shape for any of Camex's own domains. */
export function assertNotOwnDomains(
  domains: readonly string[],
  ownDomains: readonly string[],
): void {
  const issues = domains.flatMap((domain, i) =>
    isOwnDomain(domain, ownDomains)
      ? [{ path: `emailDomains.${i}`, message: `${domain} is a Camex domain` }]
      : [],
  );
  if (issues.length > 0) {
    throw new BadRequestException({ statusCode: 400, message: 'Validation failed', issues });
  }
}

/** Drops aliases whose key repeats the name's or an earlier alias's, and repeated domains. */
export function withoutRepeats(
  name: string,
  aliases: readonly string[],
  emailDomains: readonly string[],
): { aliases: string[]; emailDomains: string[] } {
  const seen = new Set([vendorKey(name)]);
  const keptAliases = aliases.filter((alias) => {
    const key = vendorKey(alias);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { aliases: keptAliases, emailDomains: [...new Set(emailDomains)] };
}

/** The names and domains a create/update request sets, with their request paths. */
export function requestedNames(input: {
  name?: string;
  aliases?: readonly string[];
}): FieldValue[] {
  return [
    ...(input.name === undefined ? [] : [{ value: input.name, field: 'name' }]),
    ...(input.aliases ?? []).map((value, i) => ({ value, field: `aliases.${i}` })),
  ];
}

export function requestedDomains(input: { emailDomains?: readonly string[] }): FieldValue[] {
  return (input.emailDomains ?? []).map((value, i) => ({ value, field: `emailDomains.${i}` }));
}
