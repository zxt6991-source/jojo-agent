import React, { useEffect, useState } from 'react';
import type {
  MemoryCandidate,
  MemoryCandidateReviewEdit,
  MemoryScopeStatus,
  MemorySettings,
  MemoryStatusSnapshot,
  ModelSelection,
  ProviderConfig
} from '@desktop-agent/contracts';

function SettingSwitch({
  id,
  title,
  description,
  checked,
  disabled = false,
  onChange
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <div className={`memory-setting-row ${disabled ? 'is-disabled' : ''}`}>
    <div className="browser-toggle-copy">
      <strong id={id}>{title}</strong>
      <span>{description}</span>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id}
      disabled={disabled}
      className={`extension-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    ><span /></button>
  </div>;
}

function ftsLabel(mode: MemoryStatusSnapshot['ftsMode']): string {
  if (mode === 'trigram') return 'FTS5 · Trigram';
  if (mode === 'unicode61') return 'FTS5 · Unicode61';
  return 'Markdown 回退';
}

function MemoryCandidateCard({
  candidate,
  busy,
  canAccept,
  onAccept,
  onReject
}: {
  candidate: MemoryCandidate;
  busy: boolean;
  canAccept: boolean;
  onAccept: (id: string, edit?: MemoryCandidateReviewEdit) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [content, setContent] = useState(candidate.content);
  const [scope, setScope] = useState(candidate.scope);
  const accept = () => onAccept(candidate.id, editing ? { title, content, scope } : undefined);
  return <article className={`memory-candidate-card ${candidate.kind === 'rule' ? 'is-rule' : ''}`}>
    <header>
      <div><span>{scope === 'global' ? 'Global' : 'Project'}</span><span>{candidate.kind}</span></div>
      <span className={`memory-candidate-confidence ${candidate.confidence}`}>{candidate.confidence}</span>
    </header>
    {editing ? <div className="memory-candidate-editor">
      <label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'project')}><option value="project">Project</option><option value="global">Global</option></select></label>
      <label>标题<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>内容<textarea maxLength={2_048} value={content} onChange={(event) => setContent(event.target.value)} /></label>
    </div> : <><strong>{candidate.title}</strong><p>{candidate.content}</p></>}
    <div className="memory-candidate-rationale"><span>Why</span><p>{candidate.rationale}</p></div>
    {candidate.kind === 'rule' && <div className="memory-candidate-rule-warning">建议启用长期规则 · 接受即表示由用户逐条确认{candidate.rule?.triggers?.length ? ` · 触发词：${candidate.rule.triggers.join('、')}` : ''}</div>}
    <footer>
      <span>来源 Session：{candidate.sessionId.slice(0, 12)} · {new Date(candidate.createdAt).toLocaleDateString()}</span>
      <div>
        <button type="button" disabled={busy} onClick={() => setEditing((value) => !value)}>{editing ? '取消编辑' : '编辑'}</button>
        <button type="button" disabled={busy} onClick={() => { void onReject(candidate.id); }}>拒绝</button>
        <button type="button" className="primary" disabled={busy || !canAccept || !title.trim() || !content.trim()} onClick={() => { void accept(); }}>接受</button>
      </div>
    </footer>
  </article>;
}

export function MemoryScopeConfigDialog({
  scope,
  busy,
  error,
  confirmDelete,
  onDelete,
  onClose
}: {
  scope: MemoryScopeStatus;
  busy: boolean;
  error: string;
  confirmDelete: boolean;
  onDelete: (entryId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const scopeName = scope.kind === 'global' ? 'Global Memory' : scope.displayName;
  const deleteEntry = async (entryId: string) => {
    if (await onDelete(entryId)) setPendingDeleteId(null);
  };
  return <div className="memory-config-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="memory-config-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-config-title">
      <header>
        <div><span>{scope.kind === 'global' ? 'Global Scope' : 'Project Scope'}</span><h2 id="memory-config-title">{scopeName} 配置</h2></div>
        <button type="button" aria-label="关闭当前配置" onClick={onClose}>×</button>
      </header>
      <div className="memory-scope-config-summary">
        <article><span>Scope</span><strong>{scope.kind}</strong></article>
        <article><span>条目</span><strong>{scope.entryCount} 条</strong></article>
        <article><span>版本</span><strong>v{scope.version}</strong></article>
        <article><span>索引</span><strong>{scope.dirty ? '需重建' : '正常'}</strong></article>
        <article><span>解析警告</span><strong>{scope.warningCount}</strong></article>
        <article><span>Content Hash</span><strong title={scope.contentHash}>{scope.contentHash.slice(0, 12) || '—'}</strong></article>
      </div>
      <code className="memory-scope-config-path" title={scope.directory}>{scope.directory}</code>
      <div className="memory-config-entries">
        <div className="memory-config-section-heading">
          <div><strong>具体配置内容</strong><span>该 Scope 中当前保存的规则、偏好、约束与其他 Memory</span></div>
        </div>
        {scope.entries.length ? <div className="memory-config-entry-list">
          {scope.entries.map((entry) => <article key={entry.id}>
            <div className="memory-config-entry-head">
              <div><span>{entry.kind}</span><span className={entry.status}>{entry.status}</span>{entry.ruleMode && <span>{entry.ruleMode}</span>}</div>
              <div className="memory-config-entry-actions">
                <code title={entry.id}>{entry.id}</code>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`删除 ${entry.title ?? entry.id}`}
                  onClick={() => {
                    if (confirmDelete) setPendingDeleteId(entry.id);
                    else void deleteEntry(entry.id);
                  }}
                >删除</button>
              </div>
            </div>
            <strong>{entry.title ?? '未命名 Memory'}</strong>
            <p>{entry.content}</p>
            <footer><span>{entry.sourceFile}</span>{entry.triggers?.length ? <span>触发词：{entry.triggers.join('、')}</span> : null}</footer>
            {pendingDeleteId === entry.id && <div className="memory-entry-delete-confirm" role="alert">
              <div><strong>确定删除这条 Memory？</strong><span>删除前会保存 Recovery Record，之后可通过 memory_restore 恢复。</span></div>
              <div>
                <button type="button" disabled={busy} onClick={() => setPendingDeleteId(null)}>取消</button>
                <button type="button" className="danger" disabled={busy} onClick={() => { void deleteEntry(entry.id); }}>{busy ? '删除中…' : '确认删除'}</button>
              </div>
            </div>}
          </article>)}
        </div> : <p className="memory-config-scope-empty">当前 Scope 暂无 Memory 条目。</p>}
      </div>
      {error && <div className="settings-error memory-config-error" role="alert">{error}</div>}
      <footer>
        <span>Markdown 是该 Scope 的权威数据源。</span>
        <button type="button" onClick={onClose}>完成</button>
      </footer>
    </section>
  </div>;
}

export function MemorySettingsPage({
  draft,
  saved,
  status,
  error,
  busy,
  workingDirectory,
  onChange,
  onSave,
  onRefresh,
  onRebuild,
  onDelete,
  onRebuildSemantic = () => undefined,
  providers = [],
  utilityModel,
  onAcceptCandidate = async () => undefined,
  onRejectCandidate = async () => undefined
}: {
  draft: MemorySettings;
  saved: MemorySettings;
  status: MemoryStatusSnapshot | null;
  error: string;
  busy: boolean;
  workingDirectory?: string;
  onChange: (settings: MemorySettings) => void;
  onSave: () => Promise<void>;
  onRefresh: () => void;
  onRebuild: (scope: 'global' | 'project') => void;
  onDelete: (scope: 'global' | 'project', entryId: string) => Promise<boolean>;
  onRebuildSemantic?: () => void;
  providers?: ProviderConfig[];
  utilityModel?: ModelSelection;
  onAcceptCandidate?: (id: string, edit?: MemoryCandidateReviewEdit) => Promise<void>;
  onRejectCandidate?: (id: string) => Promise<void>;
}) {
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);
  const update = (value: Partial<MemorySettings>) => onChange({ ...draft, ...value });
  const inactive = !draft.enabled;
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!selectedScopeId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedScopeId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedScopeId]);
  const selectedScope = status?.scopes.find((scope) => scope.id === selectedScopeId);
  const suggestionProvider = providers.find((provider) => provider.id === draft.suggestions.providerId)
    ?? providers.find((provider) => provider.id === utilityModel?.providerId)
    ?? providers[0];
  const semanticProvider = draft.semantic.providerId
    ? providers.find((provider) => provider.id === draft.semantic.providerId)
    : undefined;
  const semanticProviderRemote = semanticProvider ? !['localhost', '127.0.0.1', '0.0.0.0', '::1']
    .includes(new URL(semanticProvider.baseUrl).hostname.toLocaleLowerCase()) : false;
  return <form className={`settings-content model-settings-page memory-settings-page ${inactive ? 'is-disabled' : ''}`} aria-labelledby="memory-settings-title" onSubmit={(event) => {
    event.preventDefault();
    void onSave();
  }}>
    <div className="settings-heading">
      <div>
        <h1 id="memory-settings-title">Memory</h1>
        <p>在不同会话之间复用已确认的偏好、项目约束和设计决策。Markdown 是唯一权威数据源。</p>
      </div>
      <span className={`browser-status-pill ${saved.enabled ? 'on' : ''}`}>{saved.enabled ? '已启用' : '已关闭'}</span>
    </div>

    <section className="settings-section-card">
      <SettingSwitch
        id="memory-enabled-label"
        title="启用长期记忆"
        description="关闭后不创建快照、不触发规则，也不会向模型注入 Memory；现有文件不会删除。"
        checked={draft.enabled}
        onChange={(enabled) => update({ enabled })}
      />
      <div className="memory-scope-grid">
        <SettingSwitch
          id="memory-global-label"
          title="Global Memory"
          description="适用于所有项目的语言、工具和协作偏好。"
          checked={draft.globalEnabled}
          disabled={inactive}
          onChange={(globalEnabled) => update({ globalEnabled })}
        />
        <SettingSwitch
          id="memory-project-label"
          title="Project Memory"
          description="仅注入当前项目的约束、决策、经验和未完成事项。"
          checked={draft.projectEnabled}
          disabled={inactive}
          onChange={(projectEnabled) => update({ projectEnabled })}
        />
      </div>
    </section>

    <section className="settings-section-card memory-suggestions-settings">
      <div className="settings-section-title">
        <h2>Memory Suggestions</h2>
        <p>仅在本地高价值信号命中后调用 Utility Model；建议不会自动写入 Memory。</p>
      </div>
      <SettingSwitch
        id="memory-suggestions-label"
        title="自动提炼待审阅建议"
        description="默认关闭。每个 Operation 最多提取一次，候选不会进入 Snapshot 或正式检索。"
        checked={draft.suggestions.enabled}
        disabled={inactive}
        onChange={(enabled) => update({ suggestions: {
          ...draft.suggestions,
          enabled,
          ...(enabled && !draft.suggestions.providerId && utilityModel ? utilityModel : {})
        } })}
      />
      <div className="settings-fields memory-fields">
        <div className="settings-grid">
          <label>Provider
            <select disabled={inactive || !draft.suggestions.enabled} value={draft.suggestions.providerId ?? utilityModel?.providerId ?? ''} onChange={(event) => {
              const provider = providers.find((item) => item.id === event.target.value);
              update({ suggestions: { ...draft.suggestions, providerId: event.target.value, model: provider?.model ?? provider?.models[0] ?? '' } });
            }}>
              <option value="">未配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>Model
            <select disabled={inactive || !draft.suggestions.enabled || !suggestionProvider} value={draft.suggestions.model ?? utilityModel?.model ?? ''} onChange={(event) => update({ suggestions: { ...draft.suggestions, model: event.target.value } })}>
              <option value="">未配置</option>{suggestionProvider?.models.map((model) => <option key={model} value={model}>{model}</option>)}
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
        <div><h2>Semantic Search</h2><p>语义向量只是 FTS 的召回扩展；Markdown 仍是唯一真源。</p></div>
        <span className={`browser-status-pill ${draft.semantic.enabled ? 'on' : ''}`}>{draft.semantic.enabled ? 'On' : 'Off'}</span>
      </div>
      <SettingSwitch
        id="memory-semantic-label"
        title="启用语义检索"
        description="默认关闭。Provider 不可用、容量超限或查询失败时自动降级为 FTS。"
        checked={draft.semantic.enabled}
        disabled={inactive}
        onChange={(enabled) => update({ semantic: {
          ...draft.semantic,
          enabled,
          ...(enabled && !draft.semantic.providerId && utilityModel ? utilityModel : {})
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
              update({ semantic: { ...draft.semantic, providerId: event.target.value, model: provider?.model ?? provider?.models[0] ?? '', remoteAllowed: false } });
            }}>
              <option value="">未配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>Embedding Model
            <select disabled={inactive || !draft.semantic.enabled || !semanticProvider} value={draft.semantic.model ?? ''} onChange={(event) => update({ semantic: { ...draft.semantic, model: event.target.value } })}>
              <option value="">未配置</option>{semanticProvider?.models.map((model) => <option key={model} value={model}>{model}</option>)}
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
      <div className="memory-semantic-status">
        <article><span>Provider</span><strong>{semanticProvider ? (semanticProviderRemote ? 'Remote' : 'Local') : '—'}</strong></article>
        <article><span>Indexed</span><strong>{status?.semantic?.indexedChunks ?? 0}</strong></article>
        <article><span>Pending</span><strong>{status?.semantic?.pending ?? 0}</strong></article>
        <article><span>Failed</span><strong>{status?.semantic?.failed ?? 0}</strong></article>
        <article><span>Skipped Secret</span><strong>{status?.semantic?.skippedSecret ?? 0}</strong></article>
        <article><span>Stale</span><strong>{status?.semantic?.stale ?? 0}</strong></article>
        <button type="button" disabled={busy || !draft.semantic.enabled || !draft.semantic.providerId || !draft.semantic.model || (semanticProviderRemote && !draft.semantic.remoteAllowed)} onClick={onRebuildSemantic}>重建 Semantic Index</button>
      </div>
      {status?.semantic?.warning && <div className="settings-error memory-settings-error" role="alert">{status.semantic.warning}</div>}
    </section>

    <section className="settings-section-card memory-candidates-panel">
      <div className="settings-section-title with-meta">
        <div><h2>Pending Suggestions</h2><p>逐条接受、编辑或拒绝；没有批量接受入口。</p></div>
        <span className="browser-status-pill">{status?.pendingCandidates?.length ?? 0} 条</span>
      </div>
      {status?.pendingCandidates?.length ? <div className="memory-candidate-list">
        {status.pendingCandidates.map((candidate) => <MemoryCandidateCard
          key={candidate.id}
          candidate={candidate}
          busy={busy}
          canAccept={candidate.scope === 'global' || Boolean(workingDirectory)}
          onAccept={onAcceptCandidate}
          onReject={onRejectCandidate}
        />)}
      </div> : <p className="memory-config-scope-empty">暂无待审阅建议。</p>}
    </section>

    <section className="settings-section-card">
      <div className="settings-section-title">
        <h2>快照与检索</h2>
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
          title="启用 Memory Search"
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
        <p>Forget 会真实删除条目，但会先保存 Recovery Record。</p>
      </div>
      <div className="memory-inline-setting recovery-setting">
        <SettingSwitch
          id="memory-confirm-delete-label"
          title="删除前要求确认"
          description="Memory Forget 始终经过权限边界；启用后 UI 需要明确确认。"
          checked={draft.confirmDelete}
          disabled={inactive}
          onChange={(confirmDelete) => update({ confirmDelete })}
        />
        <label>保留天数
          <input type="number" min="1" max="365" step="1" disabled={inactive} value={draft.recoveryRetentionDays} onChange={(event) => update({ recoveryRetentionDays: Number(event.target.value) })} />
        </label>
      </div>
    </section>

    <section className="settings-section-card memory-status-card">
      <div className="settings-section-title with-meta">
        <div>
          <h2>本地索引状态</h2>
          <p>SQLite 仅用于检索投影，可随时从 Markdown 重建。</p>
        </div>
        <button type="button" className="memory-refresh-button" disabled={busy} onClick={onRefresh}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      {status ? <div className="memory-status-body">
        <div className="memory-status-summary">
          <code title={status.root}>{status.root}</code>
          <span>{ftsLabel(status.ftsMode)}</span>
        </div>
        <div className="memory-scope-status-list">
          {status.scopes.map((scope) => <article key={scope.id}>
            <div><strong>{scope.kind === 'global' ? 'Global' : scope.displayName}</strong><span>{scope.entryCount} 条 · v{scope.version}{scope.warningCount ? ` · ${scope.warningCount} 个解析警告` : ''}</span></div>
            <span className={`memory-index-state ${scope.dirty ? 'dirty' : ''}`}>{scope.dirty ? '需重建' : '正常'}</span>
            <button type="button" className="memory-view-scope-button" onClick={() => setSelectedScopeId(scope.id)}>查看配置</button>
            <button type="button" disabled={busy} onClick={() => onRebuild(scope.kind)}>重建索引</button>
          </article>)}
        </div>
        {!workingDirectory && <p className="memory-status-hint">选择一个会话后可查看当前 Project Memory。</p>}
      </div> : <div className="memory-status-empty">{busy ? '正在读取 Memory 状态…' : '点击刷新以读取本地索引状态。'}</div>}
      {error && <div className="settings-error memory-settings-error" role="alert">{error}</div>}
    </section>

    <div className="settings-actions memory-save-actions"><span>{hasUnsavedChanges ? '有尚未保存的修改。' : '设置会应用于新的 Memory Snapshot。'}</span><button className="primary" type="submit" disabled={busy}>保存 Memory 设置</button></div>
    {selectedScope && <MemoryScopeConfigDialog
      scope={selectedScope}
      busy={busy}
      error={error}
      confirmDelete={saved.confirmDelete}
      onDelete={(entryId) => onDelete(selectedScope.kind, entryId)}
      onClose={() => setSelectedScopeId(null)}
    />}
  </form>;
}
