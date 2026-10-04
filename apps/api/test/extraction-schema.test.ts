import { extractionOutputV1Schema } from '@camex/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toAnthropicJsonSchema } from '../src/extraction/anthropic/json-schema.js';

type Node = Record<string, unknown>;

/** Every object schema in the tree, with its path. */
function objectSchemas(node: unknown, path = '$'): Array<{ path: string; node: Node }> {
  if (Array.isArray(node)) return node.flatMap((item, i) => objectSchemas(item, `${path}[${i}]`));
  if (typeof node !== 'object' || node === null) return [];
  const self = node as Node;
  const found = self.type === 'object' ? [{ path, node: self }] : [];
  return [
    ...found,
    ...Object.entries(self).flatMap(([key, value]) => objectSchemas(value, `${path}.${key}`)),
  ];
}

function allKeys(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allKeys);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => [key, ...allKeys(value)]);
}

describe('extraction wire schema → JSON Schema for the provider', () => {
  const schema = toAnthropicJsonSchema(extractionOutputV1Schema);
  const json = JSON.stringify(schema);

  it('has no unions: no anyOf/oneOf and no type arrays (nullable)', () => {
    expect(allKeys(schema)).not.toContain('anyOf');
    expect(allKeys(schema)).not.toContain('oneOf');
    expect(json).not.toMatch(/"type":\[/);
  });

  it('has no optional properties and additionalProperties: false on every object', () => {
    const objects = objectSchemas(schema);
    expect(objects.map((o) => o.path)).toEqual([
      '$',
      '$.properties.lineItems.items',
      '$.properties.bankDetails',
    ]);
    for (const { path, node } of objects) {
      const properties = Object.keys(node.properties as Node);
      expect(node.required, path).toEqual(properties);
      expect(node.additionalProperties, path).toBe(false);
    }
  });

  it('keeps patterns and enums, drops keywords the API rejects', () => {
    expect(allKeys(schema)).not.toContain('$schema');
    expect(allKeys(schema)).not.toContain('$ref');
    expect(allKeys(schema)).not.toContain('format');
    expect(allKeys(schema)).not.toContain('minLength');
    const properties = schema.properties as Record<string, Node>;
    expect(properties.invoiceDate).toEqual({
      type: 'string',
      pattern: '^(\\d{4}-\\d{2}-\\d{2})?$',
    });
    expect(properties.totalAmount).toEqual({ type: 'string', pattern: '^(-?\\d+(\\.\\d+)?)?$' });
    expect(properties.paymentTermsDays).toEqual({ type: 'string', pattern: '^(\\d{1,3})?$' });
    expect(properties.currency).toEqual({ type: 'string', pattern: '^([A-Z]{3})?$' });
    expect(properties.documentType?.enum).toEqual([
      'invoice',
      'credit_note',
      'proforma',
      'statement',
      'other',
    ]);
  });

  it('does not treat field names as keywords', () => {
    const named = toAnthropicJsonSchema(
      z.strictObject({ format: z.string(), minimum: z.string() }),
    );
    expect(named.properties).toEqual({ format: { type: 'string' }, minimum: { type: 'string' } });
  });
});
