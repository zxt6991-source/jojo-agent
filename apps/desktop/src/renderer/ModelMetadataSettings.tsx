import { isModelMetadataStale, type ModelConfig, type ModelOverride } from '@desktop-agent/contracts';
const sourceLabels = { provider: 'Provider 自动检测', builtin: 'Jojo 模型库', fallback: '默认值（请确认服务限制）', user: '手动覆盖' };
export function ModelMetadataSettings({ model, onChange }: { model: ModelConfig; onChange(model: ModelConfig): void }) {
  const context = model.override?.contextWindowTokens ?? model.discovered.contextWindowTokens;
  const output = model.override?.maxOutputTokens ?? model.discovered.maxOutputTokens;
  const budget = model.override?.defaultOutputTokens ?? model.defaultOutputTokens;
  const fields = [
    ['contextWindowTokens', '上下文窗口', context, model.discovered.contextSource, 8192, 2000000],
    ['maxOutputTokens', '模型最大输出', output, model.discovered.maxOutputSource, 256, 128000],
    ['defaultOutputTokens', '默认输出预算', budget, 'fallback', 256, 128000]
  ] as const;
  const update = (field: keyof ModelOverride, value: string) => {
    const override = { ...model.override };
    if (!value) delete override[field];
    else override[field] = Number(value);
    onChange({ ...model, override });
  };
  return <section className="model-metadata" aria-label="模型限制">
    <div className="model-preferences-group">{fields.map(([field, label, value, source]) => <div className="model-preference-row" key={field}>
      <span className="model-preference-label">{label}</span>
      <div className="model-limit-value"><span>{(field === 'defaultOutputTokens' ? Math.min(value, output) : value).toLocaleString()} <span className="model-unit">tokens</span></span>
        <small>{model.override?.[field] !== undefined ? sourceLabels.user : field === 'defaultOutputTokens' ? 'Jojo 默认' : sourceLabels[source]}</small>
      </div>
    </div>)}</div>
    <p className="model-footnote">{model.discovered.discoveredAt ? `刷新时间：${new Date(model.discovered.discoveredAt).toLocaleString()}` : '尚未自动刷新'}{isModelMetadataStale(model) ? ' · 缓存已过期，可继续使用' : ''}</p>
    {model.discovered.unavailable && <p className="model-footnote model-notice" role="status">当前 Provider 未返回该模型，或新限制与覆盖值冲突；保留上次配置。</p>}
    <details className="model-advanced"><summary><span>高级模型参数</span><span className="model-disclosure" aria-hidden="true">›</span></summary>
      <div className="model-advanced-body"><p className="model-footnote">留空使用自动值；只覆盖填写的字段。</p>
        {fields.map(([field, label, value, , min, max]) => <label className="model-preference-row" key={field}>
          <span className="model-preference-label">{label}<span className="model-unit">（tokens）</span></span>
          <input type="number" min={min} max={max} step="1" placeholder={String(value)} value={model.override?.[field] ?? ''} onChange={(event) => update(field, event.target.value)} />
        </label>)}
        <div className="model-reset-row"><button className="model-secondary-button" type="button" onClick={() => { const automatic = { ...model }; delete automatic.override; onChange(automatic); }}>恢复自动检测</button></div>
      </div>
    </details>
  </section>;
}
