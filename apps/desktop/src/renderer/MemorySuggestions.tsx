import React, { useState } from 'react';
import type { MemoryCandidate, MemoryCandidateReviewEdit } from '@desktop-agent/contracts';
import { memoryKindLabel } from './memory-settings-model';

export function MemoryCandidateCard({
  candidate,
  busy,
  projectAvailable,
  onAccept,
  onReject
}: {
  candidate: MemoryCandidate;
  busy: boolean;
  projectAvailable: boolean;
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
      <div><span>{scope === 'global' ? '所有项目' : '当前项目'}</span><span>{memoryKindLabel(candidate.kind)}</span></div>

    </header>
    {editing ? <div className="memory-candidate-editor">
      <label>保存到<select value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'project')}><option value="project" disabled={!projectAvailable}>当前项目</option><option value="global">所有项目</option></select></label>
      <label>标题<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>内容<textarea maxLength={2_048} value={content} onChange={(event) => setContent(event.target.value)} /></label>
    </div> : <><strong>{candidate.title}</strong><p>{candidate.content}</p></>}
    <div className="memory-candidate-rationale"><span>为什么建议保存？</span><p>{candidate.rationale}</p></div>
    {candidate.kind === 'rule' && <div className="memory-candidate-rule-warning">建议启用长期规则 · 接受即表示由用户逐条确认{candidate.rule?.triggers?.length ? ` · 触发词：${candidate.rule.triggers.join('、')}` : ''}</div>}
    <footer>
      <details className="memory-details"><summary>建议详情</summary><p>建议置信度：{candidate.confidence}</p><p>来源 Session：{candidate.sessionId}</p><p>{new Date(candidate.createdAt).toLocaleDateString()}</p></details>
      <div>
        <button type="button" disabled={busy} onClick={() => { setTitle(candidate.title); setContent(candidate.content); setScope(candidate.scope); setEditing((value) => !value); }}>{editing ? '取消编辑' : '编辑'}</button>
        <button type="button" disabled={busy} onClick={() => { void onReject(candidate.id); }}>忽略</button>
        <button type="button" className="primary" disabled={busy || ((editing ? scope : candidate.scope) === 'project' && !projectAvailable) || !title.trim() || !content.trim()} onClick={() => { void accept(); }}>保存 Memory</button>
      </div>
    </footer>
  </article>;
}

export function MemorySuggestions({ candidates, busy, projectAvailable, onAccept, onReject }: {
  candidates: MemoryCandidate[];
  busy: boolean;
  projectAvailable: boolean;
  onAccept: (id: string, edit?: MemoryCandidateReviewEdit) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  return <section className="settings-section-card memory-candidates-panel">
    <div className="settings-section-title"><h2>待确认记忆 · {candidates.length} 条</h2><p>Jojo 发现了可能值得长期保存的信息。保存后，未来相关对话可以继续使用它；每条建议都需要你的确认。</p></div>
    {candidates.length ? <div className="memory-candidate-list">{candidates.map((candidate) => <MemoryCandidateCard key={candidate.id} candidate={candidate} busy={busy} projectAvailable={projectAvailable} onAccept={onAccept} onReject={onReject} />)}</div>
      : <p className="memory-config-scope-empty">没有待确认建议。当 Jojo 发现可能值得长期保留的信息时，会出现在这里。</p>}
  </section>;
}
