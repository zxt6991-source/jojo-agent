import { describe, expect, it } from 'vitest';
import {
  assertOutputSchema,
  MAX_OUTPUT_SCHEMA_DEPTH,
  validateStructuredOutput
} from '../src/index.js';

const schema = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' }
  },
  required: ['files', 'summary'],
  additionalProperties: false
};

describe('structured output validation', () => {
  it('parses plain or fenced JSON and validates it against JSON Schema', () => {
    expect(validateStructuredOutput('{"files":["a.ts"],"summary":"ok"}', schema)).toEqual({
      ok: true,
      value: { files: ['a.ts'], summary: 'ok' }
    });
    expect(validateStructuredOutput('```json\n{"files":[],"summary":"ok"}\n```', schema)).toEqual({
      ok: true,
      value: { files: [], summary: 'ok' }
    });
  });

  it('distinguishes invalid JSON from a schema mismatch', () => {
    expect(validateStructuredOutput('not-json', schema)).toMatchObject({
      ok: false,
      code: 'output_schema_invalid'
    });
    expect(validateStructuredOutput('{"files":"wrong","summary":"ok"}', schema)).toMatchObject({
      ok: false,
      code: 'output_schema_validation_failed'
    });
  });

  it('rejects invalid and excessively deep schemas before execution', () => {
    expect(() => assertOutputSchema({ type: 'not-a-json-schema-type' }))
      .toThrowError(expect.objectContaining({ code: 'output_schema_invalid' }));

    const root: Record<string, unknown> = {};
    let current = root;
    for (let index = 0; index <= MAX_OUTPUT_SCHEMA_DEPTH; index += 1) {
      const child: Record<string, unknown> = {};
      current.properties = { child };
      current = child;
    }
    expect(() => assertOutputSchema(root))
      .toThrowError(expect.objectContaining({ code: 'output_schema_invalid' }));
  });
});
