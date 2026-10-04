/**
 * Extraction eval (SPEC §7, T03 §7): runs the real extractor and normalization (the worker's
 * code, without DB or S3) on every fixtures/invoices/<name>.pdf that has expected/<name>.json,
 * and diffs the result per field. Calls the Anthropic API: it costs money.
 *
 *   pnpm eval:extraction                         # every fixture once
 *   pnpm eval:extraction --fixture aeg           # one fixture (repeatable)
 *   pnpm eval:extraction --model claude-opus-5-5 --repeat 3
 *
 * Writes the normalized output to fixtures/invoices/eval-out/<name>.json (gitignored).
 * Exits 1 on any scored mismatch or failed extraction.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import { type ExtractedInvoice, extractedInvoiceSchema } from '@camex/shared';
import { z } from 'zod';
import { envObjectSchema, loadRootEnvFile } from '../config/env.js';
import { createAnthropicExtractor } from '../extraction/anthropic/anthropic-extractor.js';
import { type FieldDiff, type Score, scoreExtraction } from '../extraction/eval/score.js';
import type { ExtractionUsage } from '../extraction/invoice-extractor.js';
import { normalizeExtraction } from '../extraction/normalize.js';
import { PROMPT_VERSION } from '../extraction/prompts/extract-v1.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/invoices');
const EXPECTED = resolve(FIXTURES, 'expected');
const OUT = resolve(FIXTURES, 'eval-out');

/** USD per million tokens (input, output). */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

const USAGE = `Usage: pnpm eval:extraction [--fixture <name>]... [--model <id>] [--repeat <n>]`;

interface RunResult {
  fixture: string;
  run: number;
  model: string;
  usage: ExtractionUsage;
  durationMs: number;
  /** null when the extraction itself failed. */
  actual: ExtractedInvoice | null;
  score: Score | null;
  error: string | null;
}

function show(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function table(rows: string[][]): string {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length))) ?? [];
  return rows
    .map(
      (row) =>
        '    ' +
        row
          .map((cell, col) => cell.padEnd(widths[col] ?? 0))
          .join('  ')
          .trimEnd(),
    )
    .join('\n');
}

function sideBySide(diffs: FieldDiff[]): string {
  const width = Math.max(...diffs.map((d) => d.field.length));
  return diffs
    .map((d) => {
      const marker = show(d.expected) === show(d.actual) ? '=' : '≠';
      return [
        `    ${d.field.padEnd(width)}  ${marker} expected: ${show(d.expected)}`,
        `    ${''.padEnd(width)}    actual:   ${show(d.actual)}`,
      ].join('\n');
    })
    .join('\n');
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function fixtureNames(only: string[] | undefined): Promise<string[]> {
  const pdfs = (await readdir(FIXTURES)).filter((file) => file.toLowerCase().endsWith('.pdf'));
  const expected = new Set(await readdir(EXPECTED));
  const all = pdfs
    .map((file) => file.slice(0, -'.pdf'.length))
    .filter((name) => expected.has(`${name}.json`))
    .sort();
  if (!only) return all;
  const unknown = only.filter((name) => !all.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture(s): ${unknown.join(', ')}. Available: ${all.join(', ')}`);
  }
  return all.filter((name) => only.includes(name));
}

function printResult(result: RunResult, runs: number): void {
  const passed = result.score !== null && result.score.mismatches.length === 0;
  const runLabel = runs > 1 ? ` (run ${result.run}/${runs})` : '';
  console.log(
    `\n${result.fixture}${runLabel}: ${passed ? 'PASS' : 'FAIL'} · ${result.model} · ` +
      `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens · ` +
      `${(result.durationMs / 1000).toFixed(1)} s`,
  );
  if (result.error !== null) {
    console.log(`  extraction failed: ${result.error}`);
    return;
  }
  if (result.score === null) return;
  if (result.score.mismatches.length > 0) {
    console.log('  mismatches:');
    console.log(
      table([
        ['field', 'rule', 'expected', 'actual'],
        ...result.score.mismatches.map((m) => [m.field, m.rule, show(m.expected), show(m.actual)]),
      ]),
    );
  }
  console.log('  not scored:');
  console.log(sideBySide(result.score.unscored));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', multiple: true },
      model: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const runs = z.coerce.number().int().min(1).max(10).parse(values.repeat);

  loadRootEnvFile();
  const config = envObjectSchema
    .pick({ ANTHROPIC_API_KEY: true, EXTRACTION_MODEL: true, EXTRACTION_TIMEOUT_SECONDS: true })
    .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
  if (config.ANTHROPIC_API_KEY === undefined) {
    throw new Error('ANTHROPIC_API_KEY is not set (see .env.example).');
  }
  const model = values.model ?? config.EXTRACTION_MODEL;
  const extractor = createAnthropicExtractor({
    apiKey: config.ANTHROPIC_API_KEY,
    model,
    timeoutSeconds: config.EXTRACTION_TIMEOUT_SECONDS,
  });
  // The extractor's per-call log lines would interleave with the report.
  Logger.overrideLogger(['error']);

  const names = await fixtureNames(values.fixture);
  const inputs = await Promise.all(
    names.map(async (name) => ({
      name,
      pdf: await readFile(resolve(FIXTURES, `${name}.pdf`)),
      expected: extractedInvoiceSchema.parse(
        JSON.parse(await readFile(resolve(EXPECTED, `${name}.json`), 'utf8')),
      ),
    })),
  );
  console.log(
    `Extraction eval · model ${model} · prompt ${PROMPT_VERSION} · ${names.length} fixture(s) × ${runs} run(s)`,
  );
  await mkdir(OUT, { recursive: true });

  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    // Fixtures in parallel within a run; runs one after another.
    const batch = await Promise.all(
      inputs.map(async ({ name, pdf, expected }): Promise<RunResult> => {
        const started = performance.now();
        try {
          const result = await extractor.extract({
            pdf,
            fileName: `${name}.pdf`,
            email: { from: null, subject: null },
            invoiceId: null,
          });
          const actual = normalizeExtraction(result.raw);
          await writeFile(resolve(OUT, `${name}.json`), `${JSON.stringify(actual, null, 2)}\n`);
          return {
            fixture: name,
            run,
            model: result.model,
            usage: result.usage,
            durationMs: result.durationMs,
            actual,
            score: scoreExtraction(expected, actual),
            error: null,
          };
        } catch (error) {
          return {
            fixture: name,
            run,
            model,
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: Math.round(performance.now() - started),
            actual: null,
            score: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          };
        }
      }),
    );
    for (const result of batch) printResult(result, runs);
    results.push(...batch);
  }

  // ─── Summary ───
  const passed = results.filter((r) => r.score !== null && r.score.mismatches.length === 0);
  const extracted = results.filter((r) => r.error === null);
  const inputTokens = extracted.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  const outputTokens = extracted.reduce((sum, r) => sum + r.usage.outputTokens, 0);
  const durations = extracted.map((r) => r.durationMs);
  const n = Math.max(extracted.length, 1);
  const price = PRICES[model];

  console.log('\nSummary');
  console.log(
    `  passed: ${passed.length}/${results.length} · ` +
      names
        .map((name) => {
          const mine = results.filter((r) => r.fixture === name);
          return `${name} ${mine.filter((r) => passed.includes(r)).length}/${mine.length}`;
        })
        .join(', '),
  );
  console.log(
    `  tokens: ${inputTokens} in / ${outputTokens} out in total · per invoice ${Math.round(inputTokens / n)} in / ${Math.round(outputTokens / n)} out`,
  );
  if (durations.length > 0) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length / 1000;
    console.log(
      `  duration per invoice: avg ${avg.toFixed(1)} s · min ${(Math.min(...durations) / 1000).toFixed(1)} s · max ${(Math.max(...durations) / 1000).toFixed(1)} s`,
    );
  }
  console.log(
    price
      ? `  est. cost per invoice: ${money((inputTokens * price.input + outputTokens * price.output) / 1e6 / n)} (${model}: $${price.input}/$${price.output} per MTok in/out)`
      : `  est. cost per invoice: n/a (no price for ${model})`,
  );
  console.log(`  output: ${OUT}/<name>.json (last run)`);

  if (passed.length !== results.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
