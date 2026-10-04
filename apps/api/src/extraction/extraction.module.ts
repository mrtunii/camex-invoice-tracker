import { Module } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { ExtractionHandler } from './extraction.handler.js';
import { ExtractionQueue } from './extraction-queue.js';
import { ExtractionWorkers } from './extraction.workers.js';
import { INVOICE_EXTRACTOR, type InvoiceExtractor } from './invoice-extractor.js';
import { RecoverySweep } from './recovery-sweep.js';
import { StubExtractor } from './stub-extractor.js';

/** One entry per EXTRACTOR_PROVIDER value (the type makes a missing provider a compile error). */
const extractors: Record<Env['EXTRACTOR_PROVIDER'], () => InvoiceExtractor> = {
  stub: () => new StubExtractor(),
};

function createExtractor(env: Env): InvoiceExtractor {
  return extractors[env.EXTRACTOR_PROVIDER]();
}

@Module({
  providers: [
    ExtractionQueue,
    ExtractionHandler,
    RecoverySweep,
    ExtractionWorkers,
    { provide: INVOICE_EXTRACTOR, inject: [ENV], useFactory: createExtractor },
  ],
  exports: [ExtractionQueue],
})
export class ExtractionModule {}
