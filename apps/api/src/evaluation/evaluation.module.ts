import { Module } from '@nestjs/common';
import { EvaluationWorkers } from './evaluation.workers.js';
import { InvoiceEvaluator } from './invoice-evaluator.js';

/** Vendor matching, derived dates and flags (T04), plus their daily refresh. */
@Module({
  providers: [InvoiceEvaluator, EvaluationWorkers],
  exports: [InvoiceEvaluator],
})
export class EvaluationModule {}
