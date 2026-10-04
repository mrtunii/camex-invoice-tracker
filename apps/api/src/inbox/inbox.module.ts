import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

@Module({
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
