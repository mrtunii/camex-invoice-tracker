import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  type InboxEmailDetail,
  type InboxListQuery,
  type InboxListResponse,
  inboxListQuerySchema,
  uuidSchema,
} from '@camex/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InboxService } from './inbox.service.js';

/** Log of every inbound email and manual upload (SPEC §10 Inbox). */
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(inboxListQuerySchema)) query: InboxListQuery,
  ): Promise<InboxListResponse> {
    return this.inbox.list(query);
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<InboxEmailDetail> {
    return this.inbox.get(id);
  }
}
