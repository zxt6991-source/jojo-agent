import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TeamSnapshot, TeamStatusSnapshot } from '@desktop-agent/contracts';
import { applyTeamTemplate, createTeamDraft, teamInputFromDraft, type SaveTeamInput } from './mappings';
import { TeamEditor } from './TeamEditor';
import { TeamCreateWizard } from './TeamCreateWizard';
import { TeamPreview } from './TeamPreview';
import { TeamRuntimeView } from './TeamRuntimeView';

export function TeamSettingsPage({ workspace, teams, selectedTeamId, status, busy, error, onSelect, onRefresh, onSave, onDelete, onToggleMember }: {
  workspace?: string; teams: TeamSnapshot[]; selectedTeamId: string | null; status: TeamStatusSnapshot | null; busy: boolean; error: string;
  onSelect: (teamId: string) => void; onRefresh: () => void; onSave: (input: SaveTeamInput) => Promise<TeamSnapshot>;
  onDelete: (teamId: string) => Promise<void>; onToggleMember: (teamId: string, memberId: string, enabled: boolean) => Promise<TeamSnapshot>;
}) {
  const selected = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [teams, selectedTeamId]);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tab, setTab] = useState<'members' | 'runtime'>('members');
  const [draft, setDraft] = useState(() => createTeamDraft(workspace ?? '', selected ?? undefined));
  const [revision, setRevision] = useState(selected?.revision);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const context = useRef('');
  const isNew = creating || !selected;
  useEffect(() => {
    const key = `${workspace ?? ''}:${creating ? 'new' : selected?.id ?? 'empty'}`;
    if (key !== context.current || (!dirty && !creating)) {
      context.current = key;
      setDraft(createTeamDraft(workspace ?? '', creating ? undefined : selected ?? undefined));
      setRevision(creating ? undefined : selected?.revision);
      setDirty(false); setLocalError('');
    }
  }, [workspace, selected, creating, dirty]);
  useEffect(() => { setCreating(false); setStep(1); setTab('members'); setNotice(''); }, [workspace]);
  const report = (cause: unknown) => setLocalError(cause instanceof Error ? cause.message : String(cause));
  const canLeave = () => !dirty || window.confirm('有尚未保存的团队修改，确定放弃吗？');
  const startCreate = () => { if (!canLeave()) return; setCreating(true); setStep(1); setTab('members'); setDirty(false); setNotice(''); setDraft(createTeamDraft(workspace ?? '')); };
  const save = async () => {
    setLocalError('');
    try {
      const saved = await onSave(teamInputFromDraft(draft, workspace ?? '', isNew ? undefined : revision));
      setDraft(createTeamDraft(workspace ?? '', saved)); setRevision(saved.revision); setDirty(false); setCreating(false); setStep(1); onSelect(saved.id);
      setNotice(isNew ? `团队“${saved.name}”已创建。回到项目对话，试试：“让${saved.name}分析当前项目”或“让${saved.name}检查最近修改并找出潜在问题”。` : '团队已保存。');
    } catch (cause) { report(cause); }
  };
  return <div className="settings-content team-settings-page">
    <div className="settings-heading team-settings-heading"><div><h1>团队</h1><p>让多个 AI 成员长期负责当前项目中的不同工作。</p></div><div className="team-heading-actions"><button type="button" onClick={onRefresh} disabled={busy || !workspace}>刷新</button><button className="primary" type="button" disabled={busy || !workspace} onClick={startCreate}>新建团队</button></div></div>
    {!workspace ? <div className="team-empty-state"><strong>请先打开项目</strong><span>打开或新建一个项目后即可组建团队。</span></div> : <div className="team-settings-layout">
      <aside className="team-list" aria-label="团队列表">{teams.map((team) => <button key={team.id} type="button" disabled={busy} className={!creating && selectedTeamId === team.id ? 'active' : ''} onClick={() => { if (!canLeave()) return; setDirty(false); setCreating(false); setStep(1); setNotice(''); onSelect(team.id); }}><strong>{team.name}</strong><span>{team.members.length} 名成员</span></button>)}{teams.length === 0 && <div className="team-list-empty">还没有团队，从选择用途开始。</div>}</aside>
      <div className="team-editor">
        {!isNew && <div className="team-tabs" aria-label="团队视图"><button type="button" aria-pressed={tab === 'members'} onClick={() => setTab('members')}>成员与职责</button><button type="button" aria-pressed={tab === 'runtime'} onClick={() => setTab('runtime')}>运行情况</button></div>}
        {notice && <p className="team-notice" role="status">{notice}</p>}
        {(localError || error) && <div className="settings-error" role="alert">{localError || error}</div>}
        {tab === 'runtime' && !isNew ? <TeamRuntimeView team={selected!} status={status} busy={busy} onToggle={(memberId, enabled) => { setLocalError(''); void onToggleMember(selected!.id, memberId, enabled).catch(report); }} /> : <>
          {isNew && <p className="team-wizard-steps">{step === 1 ? '① 选择用途' : '✓ 选择用途'} → {step === 2 ? '② 确认成员' : '确认成员'} → {step === 3 ? '③ 查看工作方式' : '查看工作方式'}</p>}
          {isNew && step === 1 ? <TeamCreateWizard onTemplate={(template) => { setDraft(applyTeamTemplate(draft, template)); setDirty(true); setStep(2); }} /> : <>
            {isNew && step === 3 ? <TeamPreview draft={draft} /> : <TeamEditor key={draft.id} draft={draft} busy={busy} onChange={(value) => { setDraft(value); setDirty(true); }} />}
            <div className="team-editor-actions"><div>{isNew ? <button type="button" disabled={busy} onClick={() => setStep(step === 3 ? 2 : 1)}>上一步</button> : <button className="danger" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除团队“${selected!.name}”？将删除团队配置、成员配置、历史任务和团队消息，不会删除项目文件。`)) { setLocalError(''); void onDelete(selected!.id).then(() => { setDirty(false); setStep(1); }).catch(report); } }}>删除团队</button>}</div>
            {isNew && step === 2 ? <button className="primary" type="button" disabled={busy} onClick={() => { try { teamInputFromDraft(draft, workspace); setLocalError(''); setStep(3); } catch (cause) { report(cause); } }}>下一步：查看工作方式</button> : <button className="primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : isNew ? '创建团队' : '保存团队'}</button>}</div>
          </>}
        </>}
      </div>
    </div>}
  </div>;
}
