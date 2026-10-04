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

/** One of OWN_EMAIL_DOMAINS or a subdomain of one (in.camex.aero is ours too). */
export function isOwnDomain(domain: string, ownDomains: readonly string[]): boolean {
  return ownDomains.some((own) => domain === own || domain.endsWith(`.${own}`));
}
