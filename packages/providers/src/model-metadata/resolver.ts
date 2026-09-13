import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, DEFAULT_MODEL_MAX_OUTPUT_TOKENS, DEFAULT_MODEL_OUTPUT_BUDGET_TOKENS, ModelConfigSchema, type DiscoveredModel, type ModelConfig, type ModelOverride } from '@desktop-agent/contracts';
import { lookupBuiltinModel, type BuiltinModelMetadata } from './builtin-registry.js';

export function validTokenLimit(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function resolveModelMetadata(input: {
  discovered: DiscoveredModel; builtin?: BuiltinModelMetadata; override?: ModelOverride;
}): ModelConfig {
  const { discovered, override } = input;
  const builtin = input.builtin ?? lookupBuiltinModel(discovered.id);
  const context = validTokenLimit(discovered.contextWindowTokens, 8_192, 2_000_000)
    ? { value: discovered.contextWindowTokens, source: 'provider' as const }
    : validTokenLimit(builtin?.contextWindowTokens, 8_192, 2_000_000)
      ? { value: builtin.contextWindowTokens, source: 'builtin' as const }
      : { value: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, source: 'fallback' as const };
  const output = validTokenLimit(discovered.maxOutputTokens, 256, 128_000) && discovered.maxOutputTokens < context.value
    ? { value: discovered.maxOutputTokens, source: 'provider' as const }
    : validTokenLimit(builtin?.maxOutputTokens, 256, 128_000) && builtin.maxOutputTokens < context.value
      ? { value: builtin.maxOutputTokens, source: 'builtin' as const }
      : { value: Math.min(DEFAULT_MODEL_MAX_OUTPUT_TOKENS, context.value - 1), source: 'fallback' as const };
  return ModelConfigSchema.parse({
    id: discovered.id,
    discovered: {
      contextWindowTokens: context.value, maxOutputTokens: output.value,
      contextSource: context.source, maxOutputSource: output.source,
      discoveredAt: new Date().toISOString(),
      ...(discovered.capabilities ? { capabilities: discovered.capabilities } : {})
    },
    defaultOutputTokens: Math.min(DEFAULT_MODEL_OUTPUT_BUDGET_TOKENS, output.value), ...(override ? { override } : {})
  });
}

/** Retain cached missing models (including utility/schedule references) without changing selection. */
export function mergeRefreshedModels(previous: ModelConfig[], remote: DiscoveredModel[]): ModelConfig[] {
  const old = new Map(previous.map((model) => [model.id, model]));
  const result = new Map<string, ModelConfig>();
  for (const item of remote) {
    if (result.has(item.id)) continue;
    const cached = old.get(item.id);
    const next = resolveModelMetadata({ discovered: item });
    const merged = ModelConfigSchema.safeParse({ ...next, ...(cached?.override ? { override: cached.override } : {}) });
    // A smaller remote window can conflict with an override; retain the valid cache until edited.
    result.set(item.id, merged.success ? merged.data : { ...cached!, discovered: { ...cached!.discovered, unavailable: true } });
  }
  for (const model of previous) {
    if (!result.has(model.id)) result.set(model.id, { ...model, discovered: { ...model.discovered, unavailable: true } });
  }
  return [...result.values()];
}
