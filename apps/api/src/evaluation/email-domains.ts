/** 'Billing@Mail.Vendor.example' → 'mail.vendor.example'; null without a usable domain. */
export function emailDomain(address: string | null): string | null {
  if (address === null) return null;
  const at = address.lastIndexOf('@');
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return at === -1 || domain === '' ? null : domain;
}

/** `domain` is `base` or a subdomain of it (mail.aegfuels.com is under aegfuels.com). */
export function isDomainOrSubdomain(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

/** One of OWN_EMAIL_DOMAINS or a subdomain of one (in.camex.aero is ours too). */
export function isOwnDomain(domain: string, ownDomains: readonly string[]): boolean {
  return ownDomains.some((own) => isDomainOrSubdomain(domain, own));
}

/**
 * The vendor whose email domain covers `domain` (equal, or a parent domain of it). Domains are
 * unique across vendors, but aegfuels.com and mail.aegfuels.com can belong to two vendors: the
 * most specific one wins.
 */
export function vendorForDomain<V extends { emailDomains: readonly string[] }>(
  domain: string,
  vendors: readonly V[],
): V | undefined {
  let best: { vendor: V; length: number } | undefined;
  for (const vendor of vendors) {
    for (const vendorDomain of vendor.emailDomains) {
      if (isDomainOrSubdomain(domain, vendorDomain) && vendorDomain.length > (best?.length ?? 0)) {
        best = { vendor, length: vendorDomain.length };
      }
    }
  }
  return best?.vendor;
}
