import { ModelConfigSchema, type ModelConfig, type ProviderConfig } from '@desktop-agent/contracts';

/** Apply discovery to the draft without carrying overrides across connections. */
export function applyRefreshedModels(provider: ProviderConfig, refreshed: ModelConfig[], sameConnection: boolean): { models: ModelConfig[]; model: string } {
  const available = refreshed.filter(item => !item.discovered.unavailable);
  const selected = available.find(item => item.id === provider.model) ?? available[0];
  if (!selected) throw new Error('当前服务未返回可用模型，请检查连接或账户权限。');
  const previous = new Map(sameConnection ? provider.models.map(item => [item.id, item]) : []);
  const models = (sameConnection ? refreshed : available).map(next => {
    const automatic = { ...next }; delete automatic.override;
    const old = previous.get(next.id);
    const merged = ModelConfigSchema.safeParse({ ...automatic, ...(old?.override ? { override: old.override } : {}) });
    return merged.success ? merged.data : { ...old!, discovered: { ...old!.discovered, unavailable: true } };
  });
  // Keep same-service references for existing schedules, but select a returned model by default.
  const ids = new Set(models.map(item => item.id));
  for (const old of previous.values()) {
    if (!ids.has(old.id)) models.push({ ...old, discovered: { ...old.discovered, unavailable: true } });
  }
  return { models, model: selected.id };
}
