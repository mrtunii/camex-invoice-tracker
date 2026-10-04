import { createHmac, timingSafeEqual } from 'node:crypto';
import { type EmailHeaders, emailHeadersSchema } from '@camex/shared';

/**
 * Mailgun signs every POST: signature = hex HMAC-SHA256(webhook signing key, timestamp + token).
 * Constant-time comparison; a missing field or a length mismatch is simply invalid. No timestamp
 * window: replays are harmless because ingestion is idempotent on Message-Id.
 */
export function verifyMailgunSignature(
  signingKey: string,
  fields: { timestamp?: string; token?: string; signature?: string },
): boolean {
  const { timestamp, token, signature } = fields;
  if (!timestamp || !token || !signature) return false;
  const expected = Buffer.from(
    createHmac('sha256', signingKey)
      .update(timestamp + token)
      .digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** `message-headers` is a JSON string of [name, value] pairs; anything else is dropped. */
export function parseMessageHeaders(json: string | undefined): EmailHeaders | null {
  if (!json) return null;
  try {
    const parsed = emailHeadersSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function headerValue(headers: EmailHeaders | null, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** `"ASM Aviation" <Billing@ASM.ae>` → `billing@asm.ae`; null if there is no address. */
export function parseEmailAddress(value: string | undefined): string | null {
  if (!value) return null;
  const angle = /<\s*([^<>\s]+@[^<>\s]+?)\s*>/.exec(value)?.[1];
  const bare = /[^\s<>"',;:()]+@[^\s<>"',;:()]+/.exec(value)?.[0];
  const address = angle ?? bare;
  return address ? address.toLowerCase() : null;
}
