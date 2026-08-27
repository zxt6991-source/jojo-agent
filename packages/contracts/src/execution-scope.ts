import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema)
]));

export const ExecutionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workingDirectory: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('custom'),
    type: z.string().trim().min(1).max(128),
    data: JsonValueSchema
  }).strict()
]);
export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;
