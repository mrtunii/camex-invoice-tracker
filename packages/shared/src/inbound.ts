import { z } from 'zod';

/**
 * A form field, which may be posted more than once (Mailgun also posts MIME headers as
 * top-level fields, and headers such as Received repeat): the first value is kept.
 */
const formField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (Array.isArray(value) ? value[0] : value));

/** Field names are matched case-insensitively; Mailgun's own lowercase fields win over headers. */
function lowercaseKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!(lower in result) || key === lower) result[lower] = field;
  }
  return result;
}

/**
 * The text fields of a Mailgun route `forward()` POST (multipart/form-data with attachments,
 * x-www-form-urlencoded without). Deliberately lenient: every field is optional so that a
 * missing signature is answered with 401, not 400. Attachments arrive as files, not fields.
 */
export const mailgunInboundFormSchema = z
  .preprocess(
    lowercaseKeys,
    z.object({
      timestamp: formField,
      token: formField,
      signature: formField,
      'message-id': formField,
      sender: formField,
      from: formField,
      recipient: formField,
      subject: formField,
      'body-plain': formField,
      'message-headers': formField,
    }),
  )
  .transform((form) => ({
    timestamp: form.timestamp,
    token: form.token,
    signature: form.signature,
    messageId: form['message-id'],
    sender: form.sender,
    from: form.from,
    recipient: form.recipient,
    subject: form.subject,
    bodyPlain: form['body-plain'],
    /** JSON string: [[name, value], ...] */
    messageHeaders: form['message-headers'],
  }));
export type MailgunInboundForm = z.output<typeof mailgunInboundFormSchema>;
