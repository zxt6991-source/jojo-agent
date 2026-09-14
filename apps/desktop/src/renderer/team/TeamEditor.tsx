import React, { useState } from 'react';
import type { TeamDraft } from './draft';
import { createMemberDraft } from './mappings';
import { TeamMemberCard } from './TeamMemberCard';
import { TeamMemberEditor } from './TeamMemberEditor';
import { TeamPreview } from './TeamPreview';
export function TeamEditor({ draft, onChange, busy }: { draft: TeamDraft; onChange: (draft: TeamDraft) => void; busy: boolean }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = draft.members.find((member) => member.id === editingId);
  return <fieldset className="team-editor-fields" disabled={busy}>
    <section className="settings-section-card team-definition-card"><div className="settings-section-title"><h2>成员与职责</h2><p>定义谁来做、负责什么，以及能做什么。</p></div><div className="settings-fields">
      <label>团队名称<input maxLength={120} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label>团队用途<textarea rows={2} maxLength={2000} value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label>
      <label>同时工作的成员<select value={draft.concurrencyMode} onChange={(event) => onChange({ ...draft, concurrencyMode: event.target.value as 'auto' | 'custom' })}><option value="auto">自动（推荐）</option><option value="custom">自定义</option></select></label>
      {draft.concurrencyMode === 'custom' && <label>最多同时运行的任务<input type="number" min={1} max={16} value={draft.maxConcurrency} onChange={(event) => onChange({ ...draft, maxConcurrency: event.target.value })} /></label>}
      <details><summary>团队高级设置</summary><label>团队 ID<input readOnly value={draft.id} /></label><p className="team-help">创建后保持稳定，用于运行时引用。已有团队保留保存的并发数；选择自动后按启用成员数计算（最多 3）。</p></details>
    </div></section>
    <div className="team-members-heading"><h2>成员</h2><button type="button" disabled={draft.members.length >= 32} onClick={() => { const member = createMemberDraft(draft.members.map((item) => item.id)); onChange({ ...draft, members: [...draft.members, member] }); setEditingId(member.id); }}>添加成员</button></div>
    {draft.members.map((member) => <TeamMemberCard key={member.id} member={member} canRemove={draft.members.length > 1} onEdit={() => setEditingId(member.id)} onRemove={() => onChange({ ...draft, members: draft.members.filter((item) => item.id !== member.id) })} />)}
    <TeamPreview draft={draft} />
    {editing && <TeamMemberEditor key={editing.id} member={editing} onClose={() => setEditingId(null)} onSave={(member) => { onChange({ ...draft, members: draft.members.map((item) => item.id === member.id ? member : item) }); setEditingId(null); }} />}
  </fieldset>;
}
