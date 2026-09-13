import type { DiscoveredModel } from '@desktop-agent/contracts';
export type BuiltinModelMetadata = Omit<DiscoveredModel, 'id'>;
// Verified 2026-09-12. Registry is a fallback, never authoritative for a gateway.
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://developers.openai.com/api/docs/models/gpt-5-mini
const exact = new Map<string, BuiltinModelMetadata>([
  ['gpt-4.1', { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 }],
  ['gpt-5-mini', { contextWindowTokens: 400_000, maxOutputTokens: 128_000 }]
]);
export function lookupBuiltinModel(id: string): BuiltinModelMetadata | undefined {
  const normalized = id.replace(/^openai\//u, '');
  const direct = exact.get(normalized);
  if (direct) return { ...direct };
  // Only dated snapshots of verified families; arbitrary deployment names stay unknown.
  const snapshot = /^(gpt-4\.1|gpt-5-mini)-\d{4}-\d{2}-\d{2}$/u.exec(normalized);
  return snapshot ? exact.get(snapshot[1]!) : undefined;
}
