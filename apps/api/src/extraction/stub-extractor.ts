import { setTimeout as sleep } from 'node:timers/promises';
import { emptyExtractionOutputV1 } from '@camex/shared';
import type { ExtractionResult, InvoiceExtractor } from './invoice-extractor.js';

const DELAY_MS = 500;

/** No LLM call: a valid, all-empty output after a short delay (local dev and tests). */
export class StubExtractor implements InvoiceExtractor {
  async extract(): Promise<ExtractionResult> {
    await sleep(DELAY_MS);
    return {
      model: 'stub',
      promptVersion: 'stub',
      raw: emptyExtractionOutputV1(),
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: DELAY_MS,
    };
  }
}
