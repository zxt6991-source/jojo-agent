import React from 'react';
import type { SimpleTeamMemberDraft } from './draft';
import { effectiveReadOnly } from './mappings';
import { ROLE_PRESETS } from './presets';
export function TeamMemberCard({ member, onEdit, onRemove, canRemove }: { member: SimpleTeamMemberDraft; onEdit: () => void; onRemove: () => void; canRemove: boolean }) {
  return <section className="settings-section-card team-member-card">
    <div className="team-member-title"><div><strong>{member.name}</strong><small>{ROLE_PRESETS[member.role].title} · {member.enabled ? '已启用' : '已停用'}</small></div><button type="button" onClick={onEdit}>编辑</button></div>
    <div className="team-member-summary"><p>{member.responsibility || '尚未填写主要职责'}</p><p>{effectiveReadOnly(member) ? '只能查看' : '可以修改项目'} · {member.modelMode === 'inherit' ? '跟随项目模型' : '指定模型'} · {member.delegation === 'auto' ? '可分派临时助手' : '自己完成'}</p>
      {Object.values(member.advanced).some((value) => value !== undefined) && <small>已有高级配置，保存时保留</small>}
      <button className="danger-link" type="button" disabled={!canRemove} onClick={onRemove}>移除成员</button></div>
  </section>;
}
