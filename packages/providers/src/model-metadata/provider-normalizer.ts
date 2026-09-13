import type { DiscoveredModel } from '@desktop-agent/contracts';
import { validTokenLimit } from './resolver.js';
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function normalizeDiscoveredModel(value: unknown): DiscoveredModel | undefined {
  const item = record(value);
  if (typeof item.id !== 'string' || !item.id.trim()) return undefined;
  const top = record(item.top_provider);
  const context = [top.context_length, item.context_length, item.context_window, item.contextWindowTokens].find((v) => validTokenLimit(v, 8_192, 2_000_000));
  const output = [top.max_completion_tokens, item.max_completion_tokens, item.max_output_tokens, item.maxOutputTokens].find((v) => validTokenLimit(v, 256, 128_000));
  const model: DiscoveredModel = { id: item.id.trim() };
  if (typeof context === 'number') model.contextWindowTokens = context;
  if (typeof output === 'number' && (typeof context !== 'number' || output < context)) model.maxOutputTokens = output;
  const parameters = item.supported_parameters;
  if (Array.isArray(parameters)) model.capabilities = { toolCalls: parameters.includes('tools'), structuredOutput: parameters.includes('response_format') };
  const modalities = record(item.architecture).input_modalities;
  if (Array.isArray(modalities)) model.capabilities = { ...model.capabilities, vision: modalities.includes('image') };
  return model;
}
