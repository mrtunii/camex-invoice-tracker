import { z } from 'zod';

/**
 * Keywords Anthropic structured outputs reject (platform.claude.com/docs › Structured outputs ›
 * JSON Schema limitations): `$schema`, numeric and string-length constraints, string formats
 * (only a fixed list is accepted; we use `pattern` instead) and array/object size constraints
 * beyond minItems 0/1. `pattern`, `enum`, `required` and `additionalProperties: false` stay.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'format',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]): [string, unknown] => [
        key,
        // `properties` maps field names to schemas: its keys are names, not keywords.
        key === 'properties' && typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([field, s]) => [
                field,
                strip(s),
              ]),
            )
          : strip(value),
      ]),
  );
}

/** zod → JSON Schema accepted by `output_config.format` (reused schemas are inlined: no $ref). */
export function toAnthropicJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema, { reused: 'inline', unrepresentable: 'throw' })) as Record<
    string,
    unknown
  >;
}
