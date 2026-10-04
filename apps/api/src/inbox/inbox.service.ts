import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type InboundAttachment,
  type InboxEmail,
  type InboxEmailDetail,
  type InboxListQuery,
  type InboxListResponse,
  emailHeadersSchema,
  invoiceFlagSchema,
} from '@camex/shared';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** inbound_emails.attachments as stored (snake_case, SPEC §5). */
const storedAttachmentsSchema = z.array(
  z.object({
    filename: z.string(),
    content_type: z.string(),
    size: z.number(),
    processed: z.boolean(),
  }),
);

const emailSelect = {
  id: true,
  provider: true,
  receivedAt: true,
  fromAddress: true,
  subject: true,
  attachments: true,
  invoices: {
    select: { id: true, status: true, extractionStatus: true, fileName: true, flags: true },
    orderBy: [{ fileName: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.InboundEmailSelect;

type EmailRow = Prisma.InboundEmailGetPayload<{ select: typeof emailSelect }>;

const storedFlagsSchema = z.array(invoiceFlagSchema.pick({ code: true, severity: true }));

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Newest first; keyset pagination on (received_at, id) via Prisma's cursor. */
  async list({ cursor, limit }: InboxListQuery): Promise<InboxListResponse> {
    const rows = await this.prisma.inboundEmail.findMany({
      select: emailSelect,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.toDto(row)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string): Promise<InboxEmailDetail> {
    const row = await this.prisma.inboundEmail.findUnique({
      where: { id },
      select: { ...emailSelect, bodyText: true, headers: true },
    });
    if (!row) throw new NotFoundException('Email not found');

    const headers = row.headers === null ? null : emailHeadersSchema.safeParse(row.headers);
    return {
      ...this.toDto(row),
      bodyText: row.bodyText,
      headers: headers?.success ? headers.data : null,
    };
  }

  private toDto(row: EmailRow): InboxEmail {
    return {
      id: row.id,
      provider: row.provider,
      receivedAt: row.receivedAt.toISOString(),
      fromAddress: row.fromAddress,
      subject: row.subject,
      attachments: this.attachments(row),
      invoices: row.invoices.map(({ flags, ...invoice }) => ({
        ...invoice,
        flags: storedFlagsSchema.parse(flags),
      })),
    };
  }

  private attachments(row: EmailRow): InboundAttachment[] {
    const parsed = storedAttachmentsSchema.safeParse(row.attachments);
    if (!parsed.success) {
      this.logger.warn({ inboundEmailId: row.id }, 'unreadable attachments column');
      return [];
    }
    return parsed.data.map((a) => ({
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      processed: a.processed,
    }));
  }
}
