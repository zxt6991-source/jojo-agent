import React from 'react';
import type { TeamDraft } from './draft';
import { effectiveReadOnly, teamConcurrency } from './mappings';
export function TeamPreview({ draft }: { draft: TeamDraft }) {
  const writers = draft.members.filter((member) => !effectiveReadOnly(member)).length;
  return <section className="settings-section-card team-preview"><h2>团队工作方式</h2>
    <p>{draft.members.length} 名长期成员 · {writers} 名可以修改项目 · {draft.members.length - writers} 名只读</p>
    <p>{draft.members.filter((member) => member.enabled).length} 名已启用 · 最多同时运行 {teamConcurrency(draft)} 个任务</p>
    <div className="team-preview-members" aria-label="团队职责分工">{draft.members.map((member) => <span key={member.id}>{member.name}{member.delegation === 'auto' ? ' → 临时助手' : ''}</span>)}</div>
    <p>按任务需要分派给成员，同一成员的任务依次执行。以上分工不代表自动执行顺序。</p>
    {writers > 0 && <p>可写成员可以修改项目；实际是否使用独立工作区由任务运行配置决定。</p>}
  </section>;
}
