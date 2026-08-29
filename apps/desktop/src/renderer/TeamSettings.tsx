import React, { useEffect, useMemo, useState } from 'react';
import type { DesktopApi, SubAgentProfile, TeamMemberSnapshot, TeamSnapshot, TeamStatusSnapshot } from '@desktop-agent/contracts';

const PROFILES: readonly SubAgentProfile[] = ['explore', 'general', 'code-review', 'synthesize'];

export type TeamMemberDraft = {
  id: string;
  name: string;
  description: string;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  systemPrompt: string;
  readOnly: boolean;
  toolsAllow: string;
  toolsDeny: string;
  spawnEnabled: boolean;
  spawnProfiles: string;
  spawnMaxActive: string;
};

export type TeamDraft = {
  id: string;
  name: string;
  description: string;
  maxConcurrency: string;
  members: TeamMemberDraft[];
};

type SaveTeamInput = Parameters<DesktopApi['saveTeam']>[0];

function memberDraft(member?: TeamMemberSnapshot, index = 0): TeamMemberDraft {
  return {
    id: member?.id ?? `member_${index + 1}`,
    name: member?.name ?? (index === 0 ? '架构师' : `成员 ${index + 1}`),
    description: member?.description ?? '',
    profile: member?.profile ?? 'general',
    providerId: member?.providerId ?? '',
    model: member?.model ?? '',
    systemPrompt: member?.systemPrompt ?? '',
    readOnly: member?.readOnly ?? false,
    toolsAllow: member?.tools?.allow?.join(', ') ?? '',
    toolsDeny: member?.tools?.deny?.join(', ') ?? '',
    spawnEnabled: member?.spawn?.enabled ?? false,
    spawnProfiles: member?.spawn?.profiles?.join(', ') ?? '',
    spawnMaxActive: member?.spawn?.maxActive ? String(member.spawn.maxActive) : '2'
  };
}

export function createTeamDraft(workspace: string, team?: TeamSnapshot): TeamDraft {
  if (team) {
    return {
      id: team.id,
      name: team.name,
      description: team.description ?? '',
      maxConcurrency: String(team.maxConcurrency),
      members: team.members.map((member, index) => memberDraft(member, index))
    };
  }
  return {
    id: `team_${Date.now().toString(36)}`,
    name: '新团队',
    description: '',
    maxConcurrency: '3',
    members: [memberDraft()]
  };
}

function commaList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

export function teamInputFromDraft(draft: TeamDraft, workspace: string, revision?: number): SaveTeamInput {
  const id = draft.id.trim();
  const name = draft.name.trim();
  if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new Error('团队 ID 需以小写字母开头，只能包含小写字母、数字、_ 或 -。');
  if (!name) throw new Error('请输入团队名称。');
  if (!workspace.trim()) throw new Error('请先打开一个项目，再配置团队。');
  const maxConcurrency = Number(draft.maxConcurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) throw new Error('团队并发数必须是 1 到 16 的整数。');
  if (draft.members.length === 0) throw new Error('团队至少需要一名成员。');
  const ids = new Set<string>();
  const members = draft.members.map((member, index) => {
    const memberId = member.id.trim();
    const memberName = member.name.trim();
    if (!/^[a-z][a-z0-9_-]*$/u.test(memberId)) throw new Error(`第 ${index + 1} 名成员的 ID 格式无效。`);
    if (ids.has(memberId)) throw new Error(`成员 ID 重复：${memberId}`);
    ids.add(memberId);
    if (!memberName) throw new Error(`第 ${index + 1} 名成员缺少名称。`);
    const allow = commaList(member.toolsAllow);
    const deny = commaList(member.toolsDeny);
    const spawnProfiles = commaList(member.spawnProfiles) as SubAgentProfile[];
    const invalidProfile = spawnProfiles.find((profile) => !PROFILES.includes(profile));
    if (invalidProfile) throw new Error(`成员 ${memberName} 的派生 profile 无效：${invalidProfile}`);
    const spawnMaxActive = Number(member.spawnMaxActive);
    if (member.spawnEnabled && (!Number.isInteger(spawnMaxActive) || spawnMaxActive < 1 || spawnMaxActive > 8)) {
      throw new Error(`成员 ${memberName} 的派生并发数必须是 1 到 8 的整数。`);
    }
    return {
      id: memberId,
      name: memberName,
      profile: member.profile,
      ...(member.description.trim() ? { description: member.description.trim() } : {}),
      ...(member.providerId.trim() ? { providerId: member.providerId.trim() } : {}),
      ...(member.model.trim() ? { model: member.model.trim() } : {}),
      ...(member.systemPrompt.trim() ? { systemPrompt: member.systemPrompt } : {}),
      ...(member.readOnly ? { readOnly: true } : {}),
      ...(allow.length > 0 || deny.length > 0 ? { tools: { ...(allow.length > 0 ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) } } : {}),
      ...(member.spawnEnabled ? { spawn: { enabled: true, ...(spawnProfiles.length > 0 ? { profiles: spawnProfiles } : {}), maxActive: spawnMaxActive } } : {})
    };
  });
  return {
    id,
    name,
    workspace: workspace.trim(),
    members,
    maxConcurrency,
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(revision !== undefined ? { expectedRevision: revision } : {})
  };
}

function stateLabel(state: TeamMemberSnapshot['state']): string {
  return ({ idle: '空闲', queued: '排队', running: '运行中', waiting_approval: '等待批准', disabled: '已停用', error: '异常' })[state];
}

function taskStateLabel(state: TeamStatusSnapshot['recentTasks'][number]['state']): string {
  return ({ queued: '排队', running: '运行中', waiting_approval: '等待批准', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[state];
}

export function TeamSettingsPage({
  workspace, teams, selectedTeamId, status, busy, error, onSelect, onRefresh, onSave, onDelete, onToggleMember
}: {
  workspace?: string;
  teams: TeamSnapshot[];
  selectedTeamId: string | null;
  status: TeamStatusSnapshot | null;
  busy: boolean;
  error: string;
  onSelect: (teamId: string) => void;
  onRefresh: () => void;
  onSave: (input: SaveTeamInput) => Promise<TeamSnapshot>;
  onDelete: (teamId: string) => Promise<void>;
  onToggleMember: (teamId: string, memberId: string, enabled: boolean) => Promise<TeamSnapshot>;
}) {
  const selected = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [teams, selectedTeamId]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TeamDraft>(() => createTeamDraft(workspace ?? ''));
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setDraft(createTeamDraft(workspace ?? '', creating ? undefined : selected ?? undefined));
    setLocalError('');
  }, [workspace, selected, creating]);

  const updateMember = (index: number, patch: Partial<TeamMemberDraft>) => {
    setDraft((current) => ({ ...current, members: current.members.map((member, itemIndex) => itemIndex === index ? { ...member, ...patch } : member) }));
  };
  const displayError = localError || error;

  return <div className="settings-content team-settings-page">
    <div className="settings-heading team-settings-heading">
      <div><h1>团队</h1><p>为当前项目配置可持续运行的角色、权限边界和派生能力。</p></div>
      <div className="team-heading-actions"><button type="button" onClick={onRefresh} disabled={busy || !workspace}>刷新</button><button className="primary" type="button" disabled={!workspace} onClick={() => { setCreating(true); setDraft(createTeamDraft(workspace ?? '')); }}>新建团队</button></div>
    </div>
    {!workspace && <div className="team-empty-state"><strong>请先打开项目</strong><span>团队绑定到项目工作区，打开或新建一个项目后即可配置。</span></div>}
    {workspace && <div className="team-settings-layout">
      <aside className="team-list" aria-label="团队列表">
        {teams.map((team) => <button key={team.id} type="button" className={!creating && selectedTeamId === team.id ? 'active' : ''} onClick={() => { setCreating(false); onSelect(team.id); }}>
          <strong>{team.name}</strong><span>{team.members.length} 名成员 · 并发 {team.maxConcurrency}</span>
        </button>)}
        {teams.length === 0 && <div className="team-list-empty">尚未创建团队</div>}
      </aside>
      <div className="team-editor">
        <section className="settings-section-card team-definition-card">
          <div className="settings-section-title"><h2>{creating || !selected ? '新建团队' : `编辑 ${selected.name}`}</h2><p>团队 ID 创建后不可修改；成员 ID 用于任务委派和站内消息。</p></div>
          <div className="settings-fields">
            <div className="settings-grid"><label>团队 ID<input value={draft.id} disabled={!creating && Boolean(selected)} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} /></label><label>名称<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label></div>
            <label>描述<textarea rows={2} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
            <label className="team-concurrency-field">最大并发任务数<input type="number" min="1" max="16" value={draft.maxConcurrency} onChange={(event) => setDraft((current) => ({ ...current, maxConcurrency: event.target.value }))} /></label>
          </div>
        </section>

        <div className="team-members-heading"><div><h2>成员</h2><p>同一成员的任务串行执行，不同成员可并行。</p></div><button type="button" onClick={() => setDraft((current) => ({ ...current, members: [...current.members, memberDraft(undefined, current.members.length)] }))}>添加成员</button></div>
        {draft.members.map((member, index) => {
          const snapshot = selected?.members.find((item) => item.id === member.id);
          return <section className="settings-section-card team-member-card" key={`${member.id}-${index}`}>
            <div className="team-member-title"><div><span className={`team-state-dot ${snapshot?.state ?? 'draft'}`} /><strong>{member.name || `成员 ${index + 1}`}</strong>{snapshot && <small>{stateLabel(snapshot.state)}</small>}</div><button className="danger-link" type="button" disabled={draft.members.length <= 1 || snapshot?.state === 'running'} onClick={() => setDraft((current) => ({ ...current, members: current.members.filter((_, itemIndex) => itemIndex !== index) }))}>移除</button></div>
            <div className="settings-fields">
              <div className="settings-grid"><label>成员 ID<input value={member.id} disabled={Boolean(snapshot)} onChange={(event) => updateMember(index, { id: event.target.value })} /></label><label>名称<input value={member.name} onChange={(event) => updateMember(index, { name: event.target.value })} /></label></div>
              <div className="settings-grid"><label>Profile<select value={member.profile} onChange={(event) => updateMember(index, { profile: event.target.value as SubAgentProfile })}>{PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}</select></label><label>描述<input value={member.description} onChange={(event) => updateMember(index, { description: event.target.value })} /></label></div>
              <div className="settings-grid"><label>Provider（可选）<input value={member.providerId} placeholder="继承当前 Provider" onChange={(event) => updateMember(index, { providerId: event.target.value })} /></label><label>模型（可选）<input value={member.model} placeholder="继承当前模型" onChange={(event) => updateMember(index, { model: event.target.value })} /></label></div>
              <label>系统提示词（可选）<textarea rows={3} value={member.systemPrompt} onChange={(event) => updateMember(index, { systemPrompt: event.target.value })} /></label>
              <div className="settings-grid"><label>工具允许列表（逗号分隔）<input value={member.toolsAllow} onChange={(event) => updateMember(index, { toolsAllow: event.target.value })} /></label><label>工具拒绝列表（逗号分隔）<input value={member.toolsDeny} onChange={(event) => updateMember(index, { toolsDeny: event.target.value })} /></label></div>
              <div className="team-member-toggles"><label><input type="checkbox" checked={member.readOnly} onChange={(event) => updateMember(index, { readOnly: event.target.checked })} />只读成员</label><label><input type="checkbox" checked={member.spawnEnabled} onChange={(event) => updateMember(index, { spawnEnabled: event.target.checked })} />允许派生子智能体</label>{snapshot && <label><input type="checkbox" checked={snapshot.state !== 'disabled'} disabled={busy || snapshot.state === 'running'} onChange={(event) => { setLocalError(''); void onToggleMember(selected!.id, snapshot.id, event.target.checked).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); }} />运行时启用</label>}</div>
              {member.spawnEnabled && <div className="settings-grid"><label>允许派生的 Profile<input value={member.spawnProfiles} placeholder="explore, general" onChange={(event) => updateMember(index, { spawnProfiles: event.target.value })} /></label><label>最大活跃派生数<input type="number" min="1" max="8" value={member.spawnMaxActive} onChange={(event) => updateMember(index, { spawnMaxActive: event.target.value })} /></label></div>}
            </div>
          </section>;
        })}

        {displayError && <div className="settings-error" role="alert">{displayError}</div>}
        <div className="team-editor-actions"><div>{selected && <button className="danger" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除团队“${selected.name}”？历史任务和消息也会删除。`)) { setLocalError(''); void onDelete(selected.id).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); } }}>删除团队</button>}</div><button className="primary" type="button" disabled={busy} onClick={() => {
          setLocalError('');
          try {
            const input = teamInputFromDraft(draft, workspace, selected && !creating ? selected.revision : undefined);
            void onSave(input).then((saved) => { setCreating(false); onSelect(saved.id); }).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)));
          } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
        }}>{busy ? '保存中…' : '保存团队'}</button></div>

        {selected && status?.team.id === selected.id && <section className="settings-section-card team-runtime-card">
          <div className="settings-section-title"><h2>运行状态</h2><p>{status.activeTasks.length} 个运行中 · {status.queuedTasks.length} 个排队 · {status.unreadMessages} 条未读消息</p></div>
          <div className="team-task-list">
            {[...status.activeTasks, ...status.queuedTasks, ...status.recentTasks].slice(0, 12).map((task) => <div key={task.id} className="team-task-row"><span className={`team-task-state ${task.state}`}>{taskStateLabel(task.state)}</span><div><strong>{selected.members.find((member) => member.id === task.memberId)?.name ?? task.memberId}</strong><span>{task.input}</span></div><time>{new Date(task.createdAt).toLocaleString()}</time></div>)}
            {status.activeTasks.length + status.queuedTasks.length + status.recentTasks.length === 0 && <div className="team-list-empty">该团队还没有任务记录</div>}
          </div>
        </section>}
      </div>
    </div>}
  </div>;
}
