import { setTimeout as sleep } from 'node:timers/promises';
import type { ExtractionResult, InvoiceExtractor } from './invoice-extractor.js';

/** T02 placeholder: no LLM call, an empty result after a short delay. T03 adds the real provider. */
export class StubExtractor implements InvoiceExtractor {
  async extract(): Promise<ExtractionResult> {
    await sleep(500);
    return { model: 'stub', promptVersion: 'stub', raw: {} };
  }
}
