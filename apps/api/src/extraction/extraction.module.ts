import { Module } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { createAnthropicExtractor } from './anthropic/anthropic-extractor.js';
import { ExtractionHandler } from './extraction.handler.js';
import { ExtractionQueue } from './extraction-queue.js';
import { ExtractionWorkers } from './extraction.workers.js';
import { INVOICE_EXTRACTOR, type InvoiceExtractor } from './invoice-extractor.js';
import { RecoverySweep } from './recovery-sweep.js';
import { StubExtractor } from './stub-extractor.js';

/** One entry per EXTRACTOR_PROVIDER value (the type makes a missing provider a compile error). */
const extractors: Record<Env['EXTRACTOR_PROVIDER'], (env: Env) => InvoiceExtractor> = {
  stub: () => new StubExtractor(),
  anthropic: (env) => {
    // Config validation already requires the key for this provider.
    if (env.ANTHROPIC_API_KEY === undefined) throw new Error('ANTHROPIC_API_KEY is not set');
    return createAnthropicExtractor({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.EXTRACTION_MODEL,
      timeoutSeconds: env.EXTRACTION_TIMEOUT_SECONDS,
    });
  },
};

function createExtractor(env: Env): InvoiceExtractor {
  return extractors[env.EXTRACTOR_PROVIDER](env);
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
