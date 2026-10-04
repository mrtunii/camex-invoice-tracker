import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { extractionOutputV1Schema } from '@camex/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AnthropicExtractor,
  MAX_TOKENS,
  createAnthropicClient,
} from '../src/extraction/anthropic/anthropic-extractor.js';
import { toAnthropicJsonSchema } from '../src/extraction/anthropic/json-schema.js';
import {
  type ExtractionInput,
  NonRetryableExtractionError,
} from '../src/extraction/invoice-extractor.js';
import { EXTRACT_V1_SYSTEM_PROMPT, PROMPT_VERSION } from '../src/extraction/prompts/extract-v1.js';
import { asmWireOutput } from './helpers.js';

const MODEL = 'claude-sonnet-5-5';
const PDF = Buffer.from('%PDF-1.7 fake document bytes');

const input: ExtractionInput = {
  pdf: PDF,
  fileName: 'asm.pdf',
  email: { from: 'billing@vendor.example', subject: 'Invoice 42' },
  invoiceId: '00000000-0000-0000-0000-000000000001',
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}

type Reply = () => Response;

function message(text: string, overrides: Record<string, unknown> = {}): Reply {
  return () =>
    Response.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 6000, output_tokens: 600 },
      ...overrides,
    });
}

function apiError(status: number): Reply {
  return () =>
    Response.json(
      {
        type: 'error',
        error: { type: status === 529 ? 'overloaded_error' : 'api_error', message: 'boom' },
      },
      { status, headers: { 'retry-after-ms': '1' } },
    );
}

/** An extractor whose SDK client talks to a scripted fetch instead of the network. */
function extractorWith(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: url instanceof Request ? url.url : String(url),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected API call');
    return Promise.resolve(reply());
  };
  const client = createAnthropicClient({ apiKey: 'test-key', timeoutMs: 5000, fetch });
  return { extractor: new AnthropicExtractor(client, MODEL, 5000), calls };
}

const valid = JSON.stringify(asmWireOutput());

describe('AnthropicExtractor', () => {
  beforeAll(() => {
    Logger.overrideLogger(false); // no app here: the default console logger would print
  });

  it('sends the system prompt, the PDF as a document block and the JSON schema; no tools', async () => {
    const { extractor, calls } = extractorWith([message(valid)]);
    await extractor.extract(input);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toMatch(/\/v1\/messages$/);
    const body = call?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'output_config', 'system'].sort(),
    );
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: EXTRACT_V1_SYSTEM_PROMPT,
      output_config: {
        format: { type: 'json_schema', schema: toAnthropicJsonSchema(extractionOutputV1Schema) },
      },
    });
    expect(MAX_TOKENS).toBe(8192);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');

    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    const [document, context] = messages[0]?.content ?? [];
    expect(document).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') },
    });
    expect(context?.type).toBe('text');
    const lines = String(context?.text).split('\n');
    expect(lines[0]).toMatch(/untrusted/);
    expect(lines).toContain('Email from: billing@vendor.example');
    expect(lines).toContain('Subject: Invoice 42');
    expect(lines).toContain('File name: asm.pdf');
    expect(lines.at(-1)).toBe('Extract the document.');
  });

  it('returns the validated output with the model the API reports, tokens and duration', async () => {
    const { extractor } = extractorWith([message(valid, { model: 'claude-sonnet-5-5-20261001' })]);
    const result = await extractor.extract(input);
    expect(result).toEqual({
      model: 'claude-sonnet-5-5-20261001',
      promptVersion: PROMPT_VERSION,
      raw: asmWireOutput(),
      usage: { inputTokens: 6000, outputTokens: 600 },
      durationMs: expect.any(Number),
    });
    expect(PROMPT_VERSION).toBe('extract-v1');
  });

  it('reads the text block after a thinking block', async () => {
    const { extractor } = extractorWith([
      message('', {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: valid },
        ],
      }),
    ]);
    expect((await extractor.extract(input)).raw).toEqual(asmWireOutput());
  });

  it('a refusal is non-retryable', async () => {
    const { extractor, calls } = extractorWith([
      message('', {
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    ]);
    const error = await extractor.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableExtractionError);
    expect((error as Error).message).toBe('The model declined to process this document (cyber)');
    expect(calls).toHaveLength(1);
  });

  it('output cut off at max_tokens is non-retryable and keeps what was returned', async () => {
    const { extractor, calls } = extractorWith([
      message('{"documentType":"invoice","vendorNa', { stop_reason: 'max_tokens' }),
    ]);
    const error = await extractor.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableExtractionError);
    expect((error as NonRetryableExtractionError).message).toMatch(/max_tokens/);
    expect((error as NonRetryableExtractionError).output).toEqual({
      raw: '{"documentType":"invoice","vendorNa',
      model: MODEL,
      promptVersion: PROMPT_VERSION,
    });
    expect(calls).toHaveLength(1);
  });

  it('invalid output, then valid: re-asks once with the output and the errors', async () => {
    const invalid = JSON.stringify({ ...asmWireOutput(), invoiceDate: '16-Sep-2026' });
    const { extractor, calls } = extractorWith([message(invalid), message(valid)]);
    const result = await extractor.extract(input);

    expect(result.raw).toEqual(asmWireOutput());
    expect(result.usage).toEqual({ inputTokens: 12000, outputTokens: 1200 });
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.body);
    const followUp = second?.messages as Array<{ role: string; content: unknown }>;
    expect(followUp.slice(0, 1)).toEqual(first?.messages);
    expect(followUp[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: invalid }] });
    expect(followUp[2]?.role).toBe('user');
    expect(followUp[2]?.content).toMatch(/invoiceDate/);
    expect({ ...second, messages: undefined }).toEqual({ ...first, messages: undefined });
  });

  it('invalid twice is non-retryable, with the last output kept', async () => {
    const { extractor, calls } = extractorWith([message('not json'), message('{"still":"wrong"}')]);
    const error = await extractor.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableExtractionError);
    expect((error as Error).message).toMatch(/still invalid after a re-ask/);
    expect((error as NonRetryableExtractionError).output?.raw).toEqual({ still: 'wrong' });
    expect(calls).toHaveLength(2);
  });

  it.each([500, 529])(
    '%i is a normal (retryable) error after the one SDK retry',
    async (status) => {
      const { extractor, calls } = extractorWith([apiError(status), apiError(status)]);
      const error = await extractor.extract(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Anthropic.APIError);
      expect(error).not.toBeInstanceOf(NonRetryableExtractionError);
      expect((error as InstanceType<typeof Anthropic.APIError>).status).toBe(status);
      expect(calls).toHaveLength(2);
    },
  );

  it('a 429 is also retryable', async () => {
    const { extractor } = extractorWith([apiError(429), apiError(429)]);
    const error = await extractor.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
  });
});
