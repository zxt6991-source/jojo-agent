import React, { useState } from 'react';
import type { MemoryScopeStatus, MemoryStatusSnapshot } from '@desktop-agent/contracts';
import { memoryKindLabel } from './memory-settings-model';

export function MemoryEntries({ scope, busy, onDelete, query = '' }: {
  scope: MemoryScopeStatus;
  busy: boolean;
  onDelete: (entryId: string) => Promise<boolean>;
  query?: string;
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const entries = scope.entries.filter((entry) => `${entry.title ?? ''}\n${entry.content}\n${entry.tags.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="memory-config-entry-list">
    {entries.map((entry) => <article key={entry.id}>
      <div className="memory-config-entry-head"><div><span>{memoryKindLabel(entry.kind)}</span><span>{scope.kind === 'global' ? '所有项目' : '当前项目'}</span></div><div className="memory-config-entry-actions"><button type="button" disabled={busy} aria-label={`删除 ${entry.title ?? entry.id}`} onClick={() => setPendingDeleteId(entry.id)}>删除</button></div></div>
      <strong>{entry.title ?? '未命名 Memory'}</strong><p>{entry.content}</p>
      <details className="memory-details"><summary>更多信息</summary><p>创建时间：{new Date(entry.createdAt).toLocaleString()}</p><p>状态：{entry.status} {entry.ruleMode}</p><p>Entry ID：<code>{entry.id}</code></p><p>来源文件：{entry.sourceFile}</p><p>Content Hash：<code>{entry.contentHash}</code></p>{entry.triggers?.length ? <p>触发词：{entry.triggers.join('、')}</p> : null}</details>
      {pendingDeleteId === entry.id && <div className="memory-entry-delete-confirm" role="alert"><div><strong>确定删除这条 Memory？</strong><span>删除前会保存恢复记录，并按照已保存的保留天数保留。</span></div><div><button type="button" disabled={busy} onClick={() => setPendingDeleteId(null)}>取消</button><button type="button" className="danger" disabled={busy} onClick={async () => { if (await onDelete(entry.id)) setPendingDeleteId(null); }}>{busy ? '删除中…' : '确认删除'}</button></div></div>}
    </article>)}
    {!entries.length && <p className="memory-config-scope-empty">{query.trim() ? '没有匹配的 Memory。试试其他关键词。' : '还没有保存的 Memory。你可以告诉 Jojo：“记住这个项目使用 pnpm。” 或者开启“从对话中发现记忆建议”。'}</p>}
  </div>;
}

export function MemorySavedList({ status, busy, projectAvailable, onDelete, onRefresh }: {
  status: MemoryStatusSnapshot | null;
  busy: boolean;
  projectAvailable: boolean;
  onDelete: (scope: 'global' | 'project', entryId: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const [scopeKind, setScopeKind] = useState<'global' | 'project'>('global');
  const [query, setQuery] = useState('');
  const scopes = status?.scopes.filter((scope) => scope.kind === scopeKind) ?? [];
  return <section className="settings-section-card memory-saved-panel">
    <div className="settings-section-title with-meta"><div><h2>已保存的记忆</h2><p>查看和删除 Jojo 已记住的内容。</p></div><button type="button" disabled={busy} onClick={onRefresh}>刷新</button></div>
    <div className="memory-saved-filters"><label>作用范围<select value={scopeKind} onChange={(event) => setScopeKind(event.target.value as 'global' | 'project')}><option value="global">所有项目</option><option value="project">当前项目</option></select></label><label>搜索已加载的记忆<input type="search" placeholder="搜索标题、内容或标签…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    {!status ? <p className="memory-status-hint">{busy ? '正在读取 Memory…' : '尚未读取记忆，请刷新重试。'}</p> : scopeKind === 'project' && !projectAvailable ? <p className="memory-status-hint">当前没有项目。选择一个项目后，可以单独保存该项目的约束、决策和经验。</p> : scopes.length ? scopes.map((scope) => <MemoryEntries key={scope.id} scope={scope} busy={busy} query={query} onDelete={(id) => onDelete(scope.kind, id)} />) : <p className="memory-config-scope-empty">还没有保存的 Memory。可以告诉 Jojo 要记住的信息，或者开启记忆建议。</p>}
  </section>;
}

// Keep the existing export contract for callers while making the dialog a content manager.
export function MemoryScopeConfigDialog({ scope, busy, error, onDelete, onClose }: {
  scope: MemoryScopeStatus;
  busy: boolean;
  error: string;
  confirmDelete: boolean;
  onDelete: (entryId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  return <div className="memory-config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="memory-config-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-config-title"><header><div><h2 id="memory-config-title">{scope.kind === 'global' ? '所有项目' : '当前项目'} · 管理记忆</h2></div><button type="button" aria-label="关闭记忆管理" onClick={onClose}>×</button></header><MemoryEntries scope={scope} busy={busy} onDelete={onDelete} />{error && <p className="settings-error" role="alert">{error}</p>}<footer><span>{scope.entryCount} 条记忆</span><button type="button" onClick={onClose}>完成</button></footer></section></div>;
}
