import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { StructuredOutputErrorCode } from '@desktop-agent/contracts';
import { OrchestrationError } from './errors.js';

export const MAX_OUTPUT_SCHEMA_BYTES = 32 * 1024;
export const MAX_OUTPUT_SCHEMA_DEPTH = 16;
export const MAX_OUTPUT_SCHEMA_NODES = 1_024;
export const MAX_STRUCTURED_OUTPUT_BYTES = 256 * 1024;
export const MAX_STRUCTURED_OUTPUT_DEPTH = 32;
export const MAX_STRUCTURED_OUTPUT_NODES = 10_000;
export const MAX_STRUCTURED_ARRAY_ITEMS = 2_000;

type StructuredOutputValidation =
  | { ok: true; value: unknown }
  | { ok: false; code: StructuredOutputErrorCode; message: string };

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateSchema: true
});

function inspectValueBounds(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number; maxArrayItems: number },
  label: string
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new Error(`${label} exceeds the node limit (${limits.maxNodes}).`);
    if (current.depth > limits.maxDepth) throw new Error(`${label} exceeds the depth limit (${limits.maxDepth}).`);
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) throw new Error(`${label} must not contain circular references.`);
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > limits.maxArrayItems) {
        throw new Error(`${label} exceeds the array item limit (${limits.maxArrayItems}).`);
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
  }
}

function compileOutputSchema(schema: Record<string, unknown>): ValidateFunction {
  if (Object.getPrototypeOf(schema) !== Object.prototype && Object.getPrototypeOf(schema) !== null) {
    throw new Error('Output schema must be a plain JSON object.');
  }
  inspectValueBounds(schema, {
    maxDepth: MAX_OUTPUT_SCHEMA_DEPTH,
    maxNodes: MAX_OUTPUT_SCHEMA_NODES,
    maxArrayItems: 256
  }, 'Output schema');
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error('Output schema must be JSON serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new Error(`Output schema exceeds the size limit (${MAX_OUTPUT_SCHEMA_BYTES} bytes).`);
  }
  if (schema.$async === true) throw new Error('Asynchronous output schemas are not supported.');
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Output schema is invalid: ${formatErrors(ajv.errors)}`);
  }
  return ajv.compile(schema);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'validation failed';
  return errors.slice(0, 5).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

function failure(code: StructuredOutputErrorCode, message: string): StructuredOutputValidation {
  return { ok: false, code, message };
}

function jsonPayload(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function assertOutputSchema(schema: Record<string, unknown>): void {
  try {
    compileOutputSchema(schema);
  } catch (error) {
    throw new OrchestrationError(
      'output_schema_invalid',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function structuredOutputInstruction(schema: Record<string, unknown>): string {
  assertOutputSchema(schema);
  return [
    'Return exactly one JSON value matching the following JSON Schema.',
    'Do not include Markdown fences, commentary, or any text outside the JSON value.',
    JSON.stringify(schema)
  ].join('\n');
}

export function validateStructuredOutput(
  text: string,
  schema: Record<string, unknown>
): StructuredOutputValidation {
  let validate: ValidateFunction;
  try {
    validate = compileOutputSchema(schema);
  } catch (error) {
    return failure('output_schema_invalid', error instanceof Error ? error.message : String(error));
  }
  const payload = jsonPayload(text);
  if (new TextEncoder().encode(payload).byteLength > MAX_STRUCTURED_OUTPUT_BYTES) {
    return failure('output_schema_invalid', `Structured output exceeds the size limit (${MAX_STRUCTURED_OUTPUT_BYTES} bytes).`);
  }
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return failure('output_schema_invalid', 'Agent output is not valid JSON.');
  }
  try {
    inspectValueBounds(value, {
      maxDepth: MAX_STRUCTURED_OUTPUT_DEPTH,
      maxNodes: MAX_STRUCTURED_OUTPUT_NODES,
      maxArrayItems: MAX_STRUCTURED_ARRAY_ITEMS
    }, 'Structured output');
  } catch (error) {
    return failure('output_schema_invalid', error instanceof Error ? error.message : String(error));
  }
  if (!validate(value)) {
    return failure('output_schema_validation_failed', `Structured output does not match the schema: ${formatErrors(validate.errors)}`);
  }
  return { ok: true, value };
}
