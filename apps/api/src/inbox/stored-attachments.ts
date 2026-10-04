import type { InboundAttachment } from '@camex/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

/** inbound_emails.attachments as stored (snake_case, SPEC §5). */
const storedAttachmentsSchema = z.array(
  z.object({
    filename: z.string(),
    content_type: z.string(),
    size: z.number(),
    processed: z.boolean(),
  }),
);

/** The attachments column in the API shape; null when it can't be read. */
export function attachmentsFromJson(value: Prisma.JsonValue): InboundAttachment[] | null {
  const parsed = storedAttachmentsSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.map((a) => ({
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    processed: a.processed,
  }));
}
