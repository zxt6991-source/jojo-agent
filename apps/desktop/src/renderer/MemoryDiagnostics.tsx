import React from 'react';
import type { MemorySettings, MemoryStatusSnapshot, ProviderConfig } from '@desktop-agent/contracts';
import { isRemoteMemoryProvider } from './memory-settings-model';

function ftsLabel(mode: MemoryStatusSnapshot['ftsMode']): string {
  if (mode === 'trigram') return 'FTS5 · Trigram';
  if (mode === 'unicode61') return 'FTS5 · Unicode61';
  return 'Markdown 回退';
}

export function MemoryDiagnostics({ draft, status, busy, workingDirectory, providers = [], onRefresh, onRebuild, onRebuildSemantic }: {
  draft: MemorySettings;
  status: MemoryStatusSnapshot | null;
  busy: boolean;
  workingDirectory?: string | undefined;
  providers?: ProviderConfig[];
  onRefresh: () => void;
  onRebuild: (scope: 'global' | 'project') => void;
  onRebuildSemantic?: () => void;
}) {
  const semanticProvider = providers.find((provider) => provider.id === draft.semantic.providerId);
  const semanticProviderRemote = isRemoteMemoryProvider(semanticProvider);
  return (
    <section className="settings-section-card memory-status-card">
      <div className="settings-section-title with-meta">
        <div>
          <h2>诊断与索引修复</h2>
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
            <div><strong>{scope.kind === 'global' ? '所有项目' : scope.displayName}</strong><span>{scope.entryCount} 条 · v{scope.version}{scope.warningCount ? ` · ${scope.warningCount} 个解析警告` : ''}</span></div>
            <span className={`memory-index-state ${scope.dirty ? 'dirty' : ''}`}>{scope.dirty ? '需重建' : '正常'}</span>
            <details className="memory-details"><summary>技术信息</summary><p>Content Hash：<code>{scope.contentHash}</code></p><p>目录：<code>{scope.directory}</code></p></details>
            <button type="button" disabled={busy} onClick={() => onRebuild(scope.kind)}>修复索引</button>
          </article>)}
        </div>
        {!workingDirectory && <p className="memory-status-hint">选择一个项目后可查看当前项目的索引状态。</p>}
      </div> : <div className="memory-status-empty">{busy ? '正在读取 Memory 状态…' : '点击刷新以读取本地索引状态。'}</div>}
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

  );
}
