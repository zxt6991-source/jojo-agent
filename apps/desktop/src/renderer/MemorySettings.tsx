import React, { useEffect, useState } from 'react';
import type { MemoryScopeStatus, MemorySettings, MemoryStatusSnapshot } from '@desktop-agent/contracts';

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
  onDelete
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
