import { Module } from '@nestjs/common';
import { EvaluationModule } from '../../evaluation/evaluation.module.js';
import { ExtractionModule } from '../../extraction/extraction.module.js';
import { InvoicesModule } from '../invoices.module.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';

/** Editing and the SPEC §6 state machine (T06). */
@Module({
  imports: [EvaluationModule, ExtractionModule, InvoicesModule],
  controllers: [WorkflowController],
  providers: [WorkflowService],
})
export class WorkflowModule {}
