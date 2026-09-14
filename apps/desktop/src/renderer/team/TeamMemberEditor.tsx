import React, { useEffect, useRef, useState } from 'react';
import type { SubAgentProfile } from '@desktop-agent/contracts';
import type { SimpleTeamMemberDraft } from './draft';
import { ROLE_PRESETS, type TeamRolePresetId } from './presets';
import { buildTeamMemberDefinition, changeMemberRole, resolveProfile } from './mappings';

export function TeamMemberEditor({ member, onSave, onClose }: { member: SimpleTeamMemberDraft; onSave: (member: SimpleTeamMemberDraft) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(member);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const patch = (value: Partial<SimpleTeamMemberDraft>) => setDraft((current) => ({ ...current, ...value }));
  const advanced = (value: Partial<SimpleTeamMemberDraft['advanced']>) => setDraft((current) => ({ ...current, advanced: { ...current.advanced, ...value } }));
  const list = (value: string) => [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  const profileReadOnly = ['explore', 'code-review', 'synthesize'].includes(resolveProfile(draft));
  return <dialog ref={dialog} className="team-member-dialog" onCancel={onClose} aria-labelledby="team-member-editor-title">
    <form onSubmit={(event) => { event.preventDefault(); try { buildTeamMemberDefinition(draft); onSave(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>
      <div className="team-member-title"><h2 id="team-member-editor-title">编辑成员</h2><button type="button" onClick={onClose} aria-label="关闭成员编辑">关闭</button></div>
      <div className="settings-fields">
        <label>成员名称<input autoFocus required maxLength={120} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>角色类型<select value={draft.role} onChange={(event) => setDraft(changeMemberRole(draft, event.target.value as TeamRolePresetId))}>{Object.entries(ROLE_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.title}</option>)}</select></label>
        <label>主要职责<textarea rows={3} maxLength={2000} value={draft.responsibility} onChange={(event) => patch({ responsibility: event.target.value })} /></label>
        <label>工作权限<select value={profileReadOnly ? 'read' : draft.access} onChange={(event) => patch({ access: event.target.value as 'read' | 'write' })}><option value="read">只能查看</option><option value="write" disabled={profileReadOnly}>可以修改项目</option></select></label>
        <p className="team-help">{profileReadOnly ? '该角色仅支持阅读、搜索和分析项目。需要修改文件时，请选择开发角色。' : draft.access === 'read' ? '可以阅读、搜索和分析项目，不会修改文件。' : '可以创建和修改项目文件并执行开发任务；仍需遵守项目权限。'}</p>
        <label>复杂任务时<select value={draft.delegation} onChange={(event) => patch({ delegation: event.target.value as 'auto' | 'disabled', advanced: { ...draft.advanced, spawn: undefined } })}><option value="disabled">自己完成</option><option value="auto" disabled={draft.role === 'synthesis' && !draft.advanced.spawn?.profiles?.length}>可以分派子任务给临时助手</option></select></label>
        <p className="team-help">遇到较大的任务时，可以临时调用其他 AI 助手完成调研、审查等子任务。</p>
        <label>模型<select value={draft.modelMode} onChange={(event) => patch({ modelMode: event.target.value as 'inherit' | 'custom' })}><option value="inherit">跟随当前项目</option><option value="custom">指定模型（在高级设置中配置）</option></select></label>
        <details open={draft.modelMode === 'custom' ? true : undefined}>
          <summary>高级设置{Object.values(draft.advanced).some((value) => value !== undefined) ? ' · 已有高级配置' : ''}</summary>
          <p className="team-help">这些设置用于精确控制 Agent Runtime。如果你不确定，请保留自动配置。切换角色会重新应用权限和委派默认值，其他高级配置会保留。</p>
          <label>成员 ID<input value={draft.id} readOnly /></label>
          <label>Profile<input value={resolveProfile(draft)} onChange={(event) => advanced({ profile: event.target.value as SubAgentProfile })} /></label>
          <p className="team-help">自定义 Profile 的实际权限由运行时决定。</p>
          {draft.modelMode === 'custom' && <div className="settings-grid"><label>Provider<input value={draft.advanced.providerId ?? ''} placeholder="留空则跟随当前项目" onChange={(event) => advanced({ providerId: event.target.value || undefined })} /></label><label>模型<input value={draft.advanced.model ?? ''} placeholder="留空则跟随 Profile / 当前项目" onChange={(event) => advanced({ model: event.target.value || undefined })} /></label></div>}
          <label>系统提示词覆盖<textarea rows={4} placeholder="自动根据职责生成" value={draft.autoPrompt ? '' : draft.advanced.systemPrompt ?? ''} onChange={(event) => patch({ autoPrompt: false, advanced: { ...draft.advanced, systemPrompt: event.target.value } })} /></label>
          <button type="button" onClick={() => patch({ autoPrompt: true, advanced: { ...draft.advanced, systemPrompt: undefined } })}>恢复自动提示词</button>
          <label>工具允许列表（逗号分隔）<input value={draft.advanced.tools?.allow?.join(', ') ?? ''} onChange={(event) => advanced({ tools: { ...draft.advanced.tools, allow: list(event.target.value) } })} /></label>
          <label>工具拒绝列表（逗号分隔）<input value={draft.advanced.tools?.deny?.join(', ') ?? ''} onChange={(event) => advanced({ tools: { ...draft.advanced.tools, deny: list(event.target.value) } })} /></label>
          <p className="team-help">空允许列表与未覆盖策略不同；恢复默认将完全使用 Profile 的工具策略。</p>
          <button type="button" onClick={() => advanced({ tools: undefined })}>恢复默认工具策略</button>
          {draft.delegation === 'auto' && <>
            <label>允许分派的 Profile（逗号分隔）<input value={(draft.advanced.spawn?.profiles ?? ROLE_PRESETS[draft.role].spawnProfiles).join(', ')} onChange={(event) => advanced({ spawn: { ...draft.advanced.spawn, enabled: true, profiles: list(event.target.value) as SubAgentProfile[] } })} /></label>
            <label>最多同时使用的临时助手<input type="number" min={1} max={8} value={draft.advanced.spawn?.maxActive ?? 2} onChange={(event) => advanced({ spawn: { ...draft.advanced.spawn, enabled: true, maxActive: Number(event.target.value) } })} /></label>
          </>}
        </details>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <div className="team-editor-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit">完成编辑</button></div>
    </form>
  </dialog>;
}
