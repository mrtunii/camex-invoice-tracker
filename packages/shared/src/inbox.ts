import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { extractionStatusSchema, invoiceFlagSchema, invoiceStatusSchema } from './invoices.js';

export const inboundProviderSchema = z.enum(['mailgun', 'manual']);
export type InboundProvider = z.infer<typeof inboundProviderSchema>;

/** Every attachment of an inbound email. `processed: false` = ignored (not a PDF, not stored). */
export const inboundAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  processed: z.boolean(),
});
export type InboundAttachment = z.infer<typeof inboundAttachmentSchema>;

export const inboxInvoiceSchema = z.object({
  id: uuidSchema,
  status: invoiceStatusSchema,
  extractionStatus: extractionStatusSchema,
  fileName: z.string(),
  /** Without `field`; the Inbox shows one icon whose tooltip lists the messages (T05b). */
  flags: z.array(invoiceFlagSchema.pick({ code: true, severity: true, message: true })),
});
export type InboxInvoice = z.infer<typeof inboxInvoiceSchema>;

export const inboxEmailSchema = z.object({
  id: uuidSchema,
  provider: inboundProviderSchema,
  receivedAt: isoTimestampSchema,
  fromAddress: z.string().nullable(),
  subject: z.string().nullable(),
  attachments: z.array(inboundAttachmentSchema),
  invoices: z.array(inboxInvoiceSchema),
});
export type InboxEmail = z.infer<typeof inboxEmailSchema>;

/** MIME headers as [name, value] pairs, in message order (null for manual uploads). */
export const emailHeadersSchema = z.array(z.tuple([z.string(), z.string()]));
export type EmailHeaders = z.infer<typeof emailHeadersSchema>;

export const inboxEmailDetailSchema = inboxEmailSchema.extend({
  bodyText: z.string().nullable(),
  headers: emailHeadersSchema.nullable(),
});
export type InboxEmailDetail = z.infer<typeof inboxEmailDetailSchema>;

export const INBOX_PAGE_SIZE = 25;

export const inboxListQuerySchema = z.object({
  /** Id of the last email of the previous page. */
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
});
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const inboxListResponseSchema = z.object({
  items: z.array(inboxEmailSchema),
  nextCursor: uuidSchema.nullable(),
});
export type InboxListResponse = z.infer<typeof inboxListResponseSchema>;
