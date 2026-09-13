import { z } from 'zod';

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 256_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_MODEL_OUTPUT_BUDGET_TOKENS = 16_384;

export const ModelMetadataSourceSchema = z.enum(['provider', 'builtin', 'fallback', 'user']);
export type ModelMetadataSource = z.infer<typeof ModelMetadataSourceSchema>;
const contextTokens = z.number().int().min(8_192).max(2_000_000);
const outputTokens = z.number().int().min(256).max(128_000);
export const ModelCapabilitiesSchema = z.object({
  toolCalls: z.boolean().optional(), vision: z.boolean().optional(), reasoning: z.boolean().optional(),
  promptCaching: z.boolean().optional(), structuredOutput: z.boolean().optional(), parallelToolCalls: z.boolean().optional()
}).strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type DiscoveredModel = {
  id: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
};
export const ModelOverrideSchema = z.object({
  contextWindowTokens: contextTokens.optional(), maxOutputTokens: outputTokens.optional(),
  defaultOutputTokens: outputTokens.optional()
}).strict();
export type ModelOverride = z.infer<typeof ModelOverrideSchema>;
export const ModelDiscoveredMetadataSchema = z.object({
  contextWindowTokens: contextTokens, maxOutputTokens: outputTokens,
  contextSource: z.enum(['provider', 'builtin', 'fallback']),
  maxOutputSource: z.enum(['provider', 'builtin', 'fallback']),
  discoveredAt: z.string().datetime().optional(), unavailable: z.boolean().optional(),
  capabilities: ModelCapabilitiesSchema.optional()
}).strict();
export const ModelConfigSchema = z.object({
  id: z.string().trim().min(1), discovered: ModelDiscoveredMetadataSchema,
  override: ModelOverrideSchema.optional(), defaultOutputTokens: outputTokens
}).strict().superRefine((model, ctx) => {
  const context = model.override?.contextWindowTokens ?? model.discovered.contextWindowTokens;
  const output = model.override?.maxOutputTokens ?? model.discovered.maxOutputTokens;
  if (output >= context) ctx.addIssue({ code: 'custom', message: `Max output must be smaller than context for ${model.id}.` });
  if (model.discovered.maxOutputTokens >= model.discovered.contextWindowTokens) {
    ctx.addIssue({ code: 'custom', message: `Invalid discovered limits for ${model.id}.` });
  }
  if (model.override?.defaultOutputTokens !== undefined && model.override.defaultOutputTokens > output) {
    ctx.addIssue({ code: 'custom', message: `Default output exceeds max output for ${model.id}.` });
  }
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EffectiveModelLimits = {
  contextWindowTokens: number; modelMaxOutputTokens: number; requestMaxOutputTokens: number;
};

/** Shared by all hosts; the request and context manager must receive the same budget. */
export function resolveEffectiveModelLimits(model: ModelConfig, requestOverride?: { maxOutputTokens?: number }): EffectiveModelLimits {
  const valid = ModelConfigSchema.parse(model);
  const contextWindowTokens = valid.override?.contextWindowTokens ?? valid.discovered.contextWindowTokens;
  const modelMaxOutputTokens = valid.override?.maxOutputTokens ?? valid.discovered.maxOutputTokens;
  const requested = requestOverride?.maxOutputTokens ?? valid.override?.defaultOutputTokens ?? valid.defaultOutputTokens;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('Invalid request output budget.');
  return { contextWindowTokens, modelMaxOutputTokens, requestMaxOutputTokens: Math.min(requested, modelMaxOutputTokens) };
}

export function resolveModelForRun(provider: { models: ModelConfig[] }, model: string, requestOverride?: { maxOutputTokens?: number }): EffectiveModelLimits {
  const config = provider.models.find((item) => item.id === model);
  if (!config) throw new Error(`Model ${model} is missing from provider.`);
  return resolveEffectiveModelLimits(config, requestOverride);
}

/** Legacy values remain replaceable fallback metadata, never a user override. */
export function legacyModelConfig(id: string, contextWindowTokens = 128_000, maxOutputTokens = 8_192): ModelConfig {
  return ModelConfigSchema.parse({ id, discovered: {
    contextWindowTokens, maxOutputTokens, contextSource: 'fallback', maxOutputSource: 'fallback'
  }, defaultOutputTokens: maxOutputTokens });
}
export const MODEL_METADATA_TTL_MS = 24 * 60 * 60 * 1_000;
export function isModelMetadataStale(model: ModelConfig, now = Date.now()): boolean {
  return !model.discovered.discoveredAt || now - Date.parse(model.discovered.discoveredAt) >= MODEL_METADATA_TTL_MS;
}
