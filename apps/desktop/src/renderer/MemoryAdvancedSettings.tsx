import React from 'react';
import { DEFAULT_MEMORY_SETTINGS } from '@desktop-agent/contracts';
import type { MemorySettings, ModelSelection, ProviderConfig } from '@desktop-agent/contracts';
import { SettingSwitch } from './MemorySettingSwitch';
import { isRemoteMemoryProvider } from './memory-settings-model';

export function MemoryAdvancedSettings({ draft, onChange, providers = [], utilityModel }: {
  draft: MemorySettings;
  onChange: (settings: MemorySettings) => void;
  providers?: ProviderConfig[];
  utilityModel?: ModelSelection | undefined;
}) {
  const update = (value: Partial<MemorySettings>) => onChange({ ...draft, ...value });
  const inactive = !draft.enabled;
  const suggestionProvider = providers.find((provider) => provider.id === draft.suggestions.providerId);
  const semanticProvider = providers.find((provider) => provider.id === draft.semantic.providerId);
  const semanticProviderRemote = isRemoteMemoryProvider(semanticProvider);
  return <>
    <section className="settings-section-card memory-suggestions-settings">
      <div className="settings-section-title">
        <h2>记忆建议模型与调优</h2>
        <p>开启建议时会使用已配置的 Utility Model；你也可以在这里自定义模型。</p>
      </div>
      {utilityModel && <button type="button" className="memory-reset-button" disabled={inactive || !draft.suggestions.enabled} onClick={() => update({ suggestions: { ...draft.suggestions, ...utilityModel } })}>使用当前 Utility Model</button>}
      <div className="settings-fields memory-fields">
        <div className="settings-grid">
          <label>Provider
            <select disabled={inactive || !draft.suggestions.enabled} value={draft.suggestions.providerId ?? ''} onChange={(event) => {
              const provider = providers.find((item) => item.id === event.target.value);
              update({ suggestions: { ...draft.suggestions, providerId: event.target.value || undefined, model: provider?.model ?? provider?.models[0]?.id } });
            }}>
              <option value="">未配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>Model
            <select disabled={inactive || !draft.suggestions.enabled || !suggestionProvider} value={draft.suggestions.model ?? ''} onChange={(event) => update({ suggestions: { ...draft.suggestions, model: event.target.value || undefined } })}>
              <option value="">未配置</option>{suggestionProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select>
          </label>
          <label>每回合最多候选
            <input type="number" min="1" max="3" step="1" disabled={inactive || !draft.suggestions.enabled} value={draft.suggestions.maxPerTurn} onChange={(event) => update({ suggestions: { ...draft.suggestions, maxPerTurn: Number(event.target.value) } })} />
          </label>
          <label>Evidence 最大 tokens
            <input type="number" min="256" max="3072" step="1" disabled={inactive || !draft.suggestions.enabled} value={draft.suggestions.evidenceMaxTokens} onChange={(event) => update({ suggestions: { ...draft.suggestions, evidenceMaxTokens: Number(event.target.value) } })} />
          </label>
          <label>最低 Eligibility 分数
            <input type="number" min="0" max="200" step="1" disabled={inactive || !draft.suggestions.enabled} value={draft.suggestions.minEligibilityScore} onChange={(event) => update({ suggestions: { ...draft.suggestions, minEligibilityScore: Number(event.target.value) } })} />
          </label>
        </div>
      </div>
    </section>

    <section className="settings-section-card memory-semantic-settings">
      <div className="settings-section-title with-meta">
        <div><h2>增强记忆搜索</h2><p>语义向量只是 FTS 的召回扩展；Markdown 仍是唯一真源。</p></div>
        <span className={`browser-status-pill ${draft.semantic.enabled ? 'on' : ''}`}>{draft.semantic.enabled ? 'On' : 'Off'}</span>
      </div>
      <SettingSwitch
        id="memory-semantic-label"
        title="启用增强记忆搜索"
        description="默认关闭。Provider 不可用、容量超限或查询失败时自动降级为 FTS。"
        checked={draft.semantic.enabled}
        disabled={inactive}
        onChange={(enabled) => update({ semantic: {
          ...draft.semantic,
          enabled
        } })}
      />
      <div className="settings-fields memory-fields">
        <div className="settings-grid">
          <label>Backend
            <select disabled={inactive || !draft.semantic.enabled} value={draft.semantic.mode} onChange={(event) => update({ semantic: { ...draft.semantic, mode: event.target.value as 'local-linear' | 'plugin-vector' } })}>
              <option value="local-linear">SQLite Linear Cosine</option><option value="plugin-vector">Plugin Vector（未安装时降级）</option>
            </select>
          </label>
          <label>Provider
            <select disabled={inactive || !draft.semantic.enabled} value={draft.semantic.providerId ?? ''} onChange={(event) => {
              const provider = providers.find((item) => item.id === event.target.value);
              update({ semantic: { ...draft.semantic, providerId: event.target.value || undefined, model: provider?.model ?? provider?.models[0]?.id, remoteAllowed: false } });
            }}>
              <option value="">未配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>Embedding Model
            <select disabled={inactive || !draft.semantic.enabled || !semanticProvider} value={draft.semantic.model ?? ''} onChange={(event) => update({ semantic: { ...draft.semantic, model: event.target.value || undefined } })}>
              <option value="">未配置</option>{semanticProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select>
          </label>
          <label>Search Mode
            <select disabled={inactive || !draft.semantic.enabled} value={draft.semantic.searchMode} onChange={(event) => update({ semantic: { ...draft.semantic, searchMode: event.target.value as 'fts' | 'semantic' | 'hybrid' } })}>
              <option value="hybrid">Hybrid · RRF</option><option value="semantic">Semantic（失败降级 FTS）</option><option value="fts">FTS only</option>
            </select>
          </label>
          <label>最大候选向量
            <input type="number" min="100" max="100000" step="100" disabled={inactive || !draft.semantic.enabled} value={draft.semantic.maxSemanticCandidates} onChange={(event) => update({ semantic: { ...draft.semantic, maxSemanticCandidates: Number(event.target.value) } })} />
          </label>
        </div>
      </div>
      {semanticProviderRemote && <div className="memory-semantic-privacy">
        <strong>远程 Embedding 隐私确认</strong>
        <p>启用后只把需要索引的 Memory Chunk 和搜索字符串发送给 {semanticProvider?.name}；不会发送完整 Session 或仓库全文。Secret Chunk 会被跳过。</p>
        <SettingSwitch
          id="memory-semantic-remote-label"
          title="允许发送到远程 Embedding Provider"
          description="必须由用户明确开启；切换 Provider 后会自动重置。"
          checked={draft.semantic.remoteAllowed}
          disabled={inactive || !draft.semantic.enabled}
          onChange={(remoteAllowed) => update({ semantic: { ...draft.semantic, remoteAllowed } })}
        />
      </div>}
      <div className="memory-scope-grid">
        <SettingSwitch id="memory-semantic-daily-label" title="索引 Daily Memory" description="默认不索引日常 handoff。" checked={draft.semantic.indexDaily} disabled={inactive || !draft.semantic.enabled} onChange={(indexDaily) => update({ semantic: { ...draft.semantic, indexDaily } })} />
        <SettingSwitch id="memory-semantic-scratch-label" title="索引 Scratchpad" description="默认不索引临时任务状态。" checked={draft.semantic.indexScratchpad} disabled={inactive || !draft.semantic.enabled} onChange={(indexScratchpad) => update({ semantic: { ...draft.semantic, indexScratchpad } })} />
      </div>
    </section>
    <section className="settings-section-card">
      <div className="settings-section-title">
        <h2>Memory 上下文与搜索</h2>
        <p>快照在 Session 内保持稳定；修改 Memory 后会在新 Session 或刷新点生效。</p>
      </div>
      <div className="settings-fields memory-fields">
        <div className="settings-grid">
          <label>快照最大 tokens
            <input type="number" min="256" max="4096" step="1" disabled={inactive} value={draft.maxSnapshotTokens} onChange={(event) => update({ maxSnapshotTokens: Number(event.target.value) })} />
          </label>
          <label>上下文占比上限（%）
            <input type="number" min="1" max="20" step="1" disabled={inactive} value={Math.round(draft.maxContextRatio * 100)} onChange={(event) => update({ maxContextRatio: Number(event.target.value) / 100 })} />
          </label>
        </div>
      </div>
      <button type="button" className="memory-reset-button" disabled={inactive} onClick={() => update({ maxSnapshotTokens: DEFAULT_MEMORY_SETTINGS.maxSnapshotTokens, maxContextRatio: DEFAULT_MEMORY_SETTINGS.maxContextRatio })}>恢复上下文推荐值</button>
      <SettingSwitch
        id="memory-recall-label"
        title="自动触发已确认规则"
        description="仅做本地关键词匹配；每条规则在一个 Session 中最多触发一次。"
        checked={draft.autoRecall}
        disabled={inactive}
        onChange={(autoRecall) => update({ autoRecall })}
      />
      <div className="memory-inline-setting">
        <SettingSwitch
          id="memory-search-label"
          title="允许 Agent 主动搜索 Memory"
          description="优先使用本地 FTS5；中文环境不可用时回退到受限 Markdown 扫描。"
          checked={draft.search.enabled}
          disabled={inactive}
          onChange={(enabled) => update({ search: { ...draft.search, enabled } })}
        />
        <label>最多结果
          <input type="number" min="1" max="50" step="1" disabled={inactive || !draft.search.enabled} value={draft.search.maxResults} onChange={(event) => update({ search: { ...draft.search, maxResults: Number(event.target.value) } })} />
        </label>
      </div>
    </section>

    <section className="settings-section-card">
      <div className="settings-section-title">
        <h2>删除与恢复</h2>
        <p>删除记忆前始终需要确认。已删除内容会在保留期内保存恢复记录。</p>
      </div>
      <div className="memory-inline-setting recovery-setting">
        <label>保留天数
          <input type="number" min="1" max="365" step="1" disabled={inactive} value={draft.recoveryRetentionDays} onChange={(event) => update({ recoveryRetentionDays: Number(event.target.value) })} />
        </label>
      </div>
    </section>

  </>;
}
