import React, { useEffect, useMemo, useState } from 'react';
import type {
  DesktopApi,
  ProviderConfig,
  SaveScheduleInputContract,
  ScheduleContract,
  ScheduleRunContract,
  SessionMeta,
  TeamSnapshot
} from '@desktop-agent/contracts';

type TriggerKind = 'once' | 'interval' | 'cron';

export type ScheduleDraft = {
  name: string;
  description: string;
  enabled: boolean;
  targetKind: 'agent' | 'team_member' | 'workflow';
  triggerKind: TriggerKind;
  runAt: string;
  intervalMinutes: string;
  anchorAt: string;
  cronExpression: string;
  timezone: string;
  sessionId: string;
  providerId: string;
  model: string;
  prompt: string;
  teamId: string;
  memberId: string;
  workingDirectory: string;
  workflowKind: 'saved' | 'inline';
  workflowName: string;
  workflowDefinition: string;
  workflowArgs: string;
  concurrency: 'skip' | 'queue';
  misfire: 'skip' | 'fire_once';
  graceHours: string;
};

type SaveScheduleInput = Parameters<DesktopApi['saveSchedule']>[0];

const ACTIVE_STATES = new Set<ScheduleRunContract['status']>([
  'pending', 'dispatching', 'running', 'waiting_approval'
]);

function localDateTime(value: Date): string {
  const pad = (item: number) => String(item).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function createScheduleDraft(
  sessions: SessionMeta[],
  providers: ProviderConfig[],
  teams: TeamSnapshot[] = [],
  schedule?: ScheduleContract
): ScheduleDraft {
  const target = schedule?.target.kind === 'agent' ? schedule.target : undefined;
  const teamTarget = schedule?.target.kind === 'team_member' ? schedule.target : undefined;
  const workflowTarget = schedule?.target.kind === 'workflow' ? schedule.target : undefined;
  const provider = providers.find((item) => item.id === (target?.providerId ?? teamTarget?.providerId ?? workflowTarget?.providerId)) ?? providers[0];
  const selectedTeam = teams.find((team) => team.id === teamTarget?.teamId) ?? teams[0];
  const now = new Date();
  const nextHour = new Date(now.getTime() + 60 * 60_000);
  nextHour.setSeconds(0, 0);
  const spec = schedule?.spec;
  return {
    name: schedule?.name ?? '新自动化',
    description: schedule?.description ?? '',
    enabled: schedule?.enabled ?? true,
    targetKind: workflowTarget ? 'workflow' : teamTarget ? 'team_member' : 'agent',
    triggerKind: spec?.kind ?? 'cron',
    runAt: localDateTime(spec?.kind === 'once' ? new Date(spec.runAt) : nextHour),
    intervalMinutes: spec?.kind === 'interval' ? String(spec.intervalMs / 60_000) : '60',
    anchorAt: localDateTime(spec?.kind === 'interval' ? new Date(spec.anchorAt) : now),
    cronExpression: spec?.kind === 'cron' ? spec.expression : '0 8 * * *',
    timezone: spec?.kind === 'cron' ? spec.timezone : defaultTimezone(),
    sessionId: target?.sessionId ?? teamTarget?.parentSessionId ?? workflowTarget?.sessionId ?? sessions[0]?.id ?? '',
    providerId: target?.providerId ?? teamTarget?.providerId ?? workflowTarget?.providerId ?? provider?.id ?? '',
    model: target?.model ?? teamTarget?.model ?? workflowTarget?.model ?? provider?.model ?? '',
    prompt: target?.input.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? teamTarget?.task ?? '',
    teamId: teamTarget?.teamId ?? selectedTeam?.id ?? '',
    memberId: teamTarget?.memberId ?? selectedTeam?.members[0]?.id ?? '',
    workingDirectory: workflowTarget?.workingDirectory ?? sessions[0]?.workingDirectory ?? '',
    workflowKind: workflowTarget?.workflow.kind ?? 'saved',
    workflowName: workflowTarget?.workflow.kind === 'saved' ? workflowTarget.workflow.name : 'code-review',
    workflowDefinition: workflowTarget?.workflow.kind === 'inline'
      ? JSON.stringify(workflowTarget.workflow.definition, null, 2)
      : '{\n  "schemaVersion": 1,\n  "name": "scheduled-workflow",\n  "steps": []\n}',
    workflowArgs: workflowTarget?.workflow.args ? JSON.stringify(workflowTarget.workflow.args, null, 2) : '{}',
    concurrency: schedule?.concurrency === 'queue' ? 'queue' : 'skip',
    misfire: schedule?.misfire.kind ?? 'fire_once',
    graceHours: schedule?.misfire.kind === 'fire_once' ? String(schedule.misfire.graceMs / 3_600_000) : '24'
  };
}

export function scheduleInputFromDraft(
  draft: ScheduleDraft,
  providers: ProviderConfig[],
  teams: TeamSnapshot[] = [],
  sessions: SessionMeta[] = [],
  schedule?: ScheduleContract
): SaveScheduleInput {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) throw new Error('请输入自动化名称。');
  if (!draft.sessionId) throw new Error('请选择会话。');
  if (!draft.providerId || !draft.model) throw new Error('请选择 Provider 和模型。');
  if (!prompt) throw new Error('请输入运行提示词。');
  const provider = providers.find((item) => item.id === draft.providerId);
  if (!provider) throw new Error('所选 Provider 已不存在。');
  if (!provider.models.includes(draft.model)) throw new Error('所选模型不在 Provider 的可用模型中。');
  if (draft.targetKind === 'team_member') {
    const team = teams.find((item) => item.id === draft.teamId);
    if (!team) throw new Error('请选择团队。');
    if (!team.members.some((member) => member.id === draft.memberId)) throw new Error('请选择团队成员。');
  }
  const session = sessions.find((item) => item.id === draft.sessionId);
  if (draft.targetKind === 'workflow' && !session) throw new Error('Workflow 需要有效的父会话。');

  let spec: SaveScheduleInputContract['spec'];
  if (draft.triggerKind === 'once') {
    const runAt = new Date(draft.runAt);
    if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now()) throw new Error('单次运行时间必须晚于当前时间。');
    spec = { kind: 'once', runAt: runAt.toISOString() };
  } else if (draft.triggerKind === 'interval') {
    const intervalMinutes = Number(draft.intervalMinutes);
    const anchorAt = new Date(draft.anchorAt);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error('间隔必须是不小于 1 的整数分钟。');
    if (!Number.isFinite(anchorAt.getTime())) throw new Error('请输入有效的间隔起算时间。');
    spec = { kind: 'interval', intervalMs: intervalMinutes * 60_000, anchorAt: anchorAt.toISOString() };
  } else {
    if (!draft.cronExpression.trim()) throw new Error('请输入 Cron 表达式。');
    if (!draft.timezone.trim()) throw new Error('请输入 IANA 时区。');
    spec = { kind: 'cron', expression: draft.cronExpression.trim(), timezone: draft.timezone.trim() };
  }

  const graceHours = Number(draft.graceHours);
  if (draft.misfire === 'fire_once' && (!Number.isFinite(graceHours) || graceHours < 0)) {
    throw new Error('补跑宽限时间必须是非负小时数。');
  }
  let workflowArgs: Record<string, unknown> | undefined;
  let workflowDefinition: unknown;
  if (draft.targetKind === 'workflow') {
    try {
      const parsed = JSON.parse(draft.workflowArgs || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      workflowArgs = parsed as Record<string, unknown>;
    } catch {
      throw new Error('Workflow Args 必须是 JSON 对象。');
    }
    if (draft.workflowKind === 'saved' && !draft.workflowName.trim()) throw new Error('请输入 Saved Workflow 名称。');
    if (draft.workflowKind === 'inline') {
      try { workflowDefinition = JSON.parse(draft.workflowDefinition); }
      catch { throw new Error('Inline Workflow Definition 必须是有效 JSON。'); }
    }
  }
  return {
    ...(schedule ? { scheduleId: schedule.id, expectedRevision: schedule.revision } : {}),
    name,
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    enabled: draft.enabled,
    spec,
    target: draft.targetKind === 'agent' ? {
        kind: 'agent',
        sessionId: draft.sessionId,
        providerId: draft.providerId,
        model: draft.model,
        input: { content: [{ type: 'text', text: prompt }] },
        lane: { mode: 'dedicated' },
        budget: {
          contextWindowTokens: provider.contextWindowTokens,
          maxOutputTokens: provider.maxOutputTokens
        }
      } : draft.targetKind === 'team_member' ? {
        kind: 'team_member',
        teamId: draft.teamId,
        memberId: draft.memberId,
        task: prompt,
        parentSessionId: draft.sessionId,
        providerId: draft.providerId,
        model: draft.model
      } : {
        kind: 'workflow',
        sessionId: draft.sessionId,
        workingDirectory: session!.workingDirectory,
        providerId: draft.providerId,
        model: draft.model,
        workflow: draft.workflowKind === 'saved'
          ? { kind: 'saved', name: draft.workflowName.trim(), ...(workflowArgs ? { args: workflowArgs } : {}) }
          : { kind: 'inline', definition: workflowDefinition, ...(workflowArgs ? { args: workflowArgs } : {}) }
      },
    misfire: draft.misfire === 'skip'
      ? { kind: 'skip' }
      : { kind: 'fire_once', graceMs: Math.round(graceHours * 3_600_000) },
    concurrency: draft.concurrency
  };
}

function triggerLabel(schedule: ScheduleContract): string {
  if (schedule.spec.kind === 'once') return `单次 · ${new Date(schedule.spec.runAt).toLocaleString()}`;
  if (schedule.spec.kind === 'interval') return `每 ${schedule.spec.intervalMs / 60_000} 分钟`;
  return `${schedule.spec.expression} · ${schedule.spec.timezone}`;
}

function runStateLabel(status: ScheduleRunContract['status']): string {
  return ({
    pending: '排队', dispatching: '派发中', running: '运行中', waiting_approval: '等待批准',
    completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过', interrupted: '已中断'
  })[status];
}

export function scheduleRunDetails(
  run: Pick<ScheduleRunContract, 'status' | 'resultPreview' | 'error'>
): { kind: 'result' | 'error' | 'empty'; label: string; content: string } | undefined {
  if (run.resultPreview) return { kind: 'result', label: '查看结果', content: run.resultPreview };
  if (run.error) return { kind: 'error', label: '查看错误详情', content: run.error };
  if (run.status === 'completed') {
    return { kind: 'empty', label: '执行结果', content: '执行已完成，但没有产生文本输出。' };
  }
  return undefined;
}

function ScheduleRunHistoryItem({
  run,
  busy,
  onCancel
}: {
  run: ScheduleRunContract;
  busy: boolean;
  onCancel(runId: string): Promise<void>;
}) {
  const details = scheduleRunDetails(run);
  return <article>
    <span className={`automation-run-state ${run.status}`}>{runStateLabel(run.status)}</span>
    <div>
      <strong>{new Date(run.scheduledFor).toLocaleString()}</strong>
      <small>{run.trigger === 'manual' ? '手动运行' : run.trigger === 'misfire' ? '离线补跑' : '定时触发'}{run.error ? ` · ${run.error}` : ''}</small>
    </div>
    <time>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}</time>
    {ACTIVE_STATES.has(run.status) && <button type="button" disabled={busy} onClick={() => void onCancel(run.id)}>
      取消
    </button>}
    {details?.kind === 'empty' && <p className="automation-run-empty">{details.content}</p>}
    {details && details.kind !== 'empty' && <details className={`automation-run-detail ${details.kind}`}>
      <summary>{details.label}</summary>
      <pre>{details.content}</pre>
    </details>}
  </article>;
}

export function SchedulerSettingsPage({
  sessions, providers, teams, schedules, selectedScheduleId, runs, busy, error,
  onSelect, onRefresh, onSave, onDelete, onEnabled, onRunNow, onCancelRun
}: {
  sessions: SessionMeta[];
  providers: ProviderConfig[];
  teams: TeamSnapshot[];
  schedules: ScheduleContract[];
  selectedScheduleId: string | null;
  runs: ScheduleRunContract[];
  busy: boolean;
  error: string;
  onSelect(scheduleId: string): void;
  onRefresh(): void;
  onSave(input: SaveScheduleInput): Promise<ScheduleContract>;
  onDelete(scheduleId: string): Promise<void>;
  onEnabled(schedule: ScheduleContract, enabled: boolean): Promise<ScheduleContract>;
  onRunNow(scheduleId: string): Promise<ScheduleRunContract>;
  onCancelRun(runId: string): Promise<void>;
}) {
  const selected = useMemo(
    () => schedules.find((schedule) => schedule.id === selectedScheduleId) ?? null,
    [schedules, selectedScheduleId]
  );
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(() => createScheduleDraft(sessions, providers, teams));
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setDraft(createScheduleDraft(sessions, providers, teams, creating ? undefined : selected ?? undefined));
    setLocalError('');
  }, [sessions, providers, teams, selected, creating]);

  const activeProvider = providers.find((provider) => provider.id === draft.providerId) ?? providers[0];
  const activeTeam = teams.find((team) => team.id === draft.teamId) ?? teams[0];
  const displayError = localError || error;
  const update = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return <div className="settings-content model-settings-page automations-settings-page">
    <div className="settings-heading automations-heading">
      <div><h1>Automations</h1><p>持久化运行定时 Agent；应用重启后会按补跑策略恢复。</p></div>
      <div><button type="button" disabled={busy} onClick={onRefresh}>刷新</button><button className="primary" type="button" disabled={sessions.length === 0} onClick={() => { setCreating(true); setDraft(createScheduleDraft(sessions, providers, teams)); }}>新建自动化</button></div>
    </div>
    {sessions.length === 0 && <div className="automation-empty"><strong>请先创建会话</strong><span>自动化需要一个会话来确定工作区与持久上下文。</span></div>}
    {sessions.length > 0 && <div className="automations-layout">
      <aside className="automation-list" aria-label="自动化列表">
        {schedules.map((schedule) => <button key={schedule.id} type="button" className={!creating && selected?.id === schedule.id ? 'active' : ''} onClick={() => { setCreating(false); onSelect(schedule.id); }}>
          <span className={`automation-state-dot ${schedule.enabled ? 'enabled' : 'disabled'}`} />
          <span><strong>{schedule.name}</strong><small>{triggerLabel(schedule)}</small></span>
        </button>)}
        {schedules.length === 0 && <div className="automation-list-empty">尚未创建自动化</div>}
      </aside>
      <div className="automation-editor">
        <section className="settings-section-card">
          <div className="settings-section-title with-meta"><div><h2>{creating || !selected ? '新建自动化' : selected.name}</h2><p>Agent、Team Member 与 Workflow 都复用各自现有的持久化、恢复和权限边界。</p></div>{selected && !creating && <label className="automation-enable"><input type="checkbox" checked={selected.enabled} disabled={busy} onChange={(event) => { void onEnabled(selected, event.target.checked).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); }} />启用</label>}</div>
          <div className="settings-fields automation-fields">
            <div className="settings-grid"><label>名称<input value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label><label>运行目标<select value={draft.targetKind} onChange={(event) => update({ targetKind: event.target.value as ScheduleDraft['targetKind'] })}><option value="agent">Agent</option><option value="team_member">Team Member</option><option value="workflow">Workflow</option></select></label></div>
            <label>父会话 / 工作区<select value={draft.sessionId} onChange={(event) => { const session = sessions.find((item) => item.id === event.target.value); update({ sessionId: event.target.value, workingDirectory: session?.workingDirectory ?? '' }); }}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
            {draft.targetKind === 'team_member' && <div className="settings-grid"><label>团队<select value={draft.teamId} onChange={(event) => { const team = teams.find((item) => item.id === event.target.value); update({ teamId: event.target.value, memberId: team?.members[0]?.id ?? '' }); }}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>成员<select value={draft.memberId} onChange={(event) => update({ memberId: event.target.value })}>{activeTeam?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>}
            {draft.targetKind === 'workflow' && <>
              <div className="settings-grid"><label>Workflow 来源<select value={draft.workflowKind} onChange={(event) => update({ workflowKind: event.target.value as ScheduleDraft['workflowKind'] })}><option value="saved">Saved Workflow</option><option value="inline">Inline Definition</option></select></label>{draft.workflowKind === 'saved' && <label>Saved Workflow 名称<input value={draft.workflowName} onChange={(event) => update({ workflowName: event.target.value })} placeholder="code-review" /></label>}</div>
              {draft.workflowKind === 'inline' && <label>Workflow Definition（JSON）<textarea rows={8} value={draft.workflowDefinition} onChange={(event) => update({ workflowDefinition: event.target.value })} /></label>}
              <label>Workflow Args（JSON 对象）<textarea rows={3} value={draft.workflowArgs} onChange={(event) => update({ workflowArgs: event.target.value })} /></label>
            </>}
            <label>描述（可选）<input value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>
            <label>提示词<textarea rows={5} value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="例如：检查当前项目的变更，并生成每日代码审查摘要。" /></label>
            <div className="settings-grid"><label>Provider<select value={draft.providerId} onChange={(event) => { const provider = providers.find((item) => item.id === event.target.value); update({ providerId: event.target.value, model: provider?.model ?? '' }); }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label>模型<select value={draft.model} onChange={(event) => update({ model: event.target.value })}>{activeProvider?.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label></div>
          </div>
        </section>

        <section className="settings-section-card">
          <div className="settings-section-title"><h2>触发时间</h2><p>支持单次、固定间隔和带时区的 Cron。</p></div>
          <div className="automation-trigger-tabs">{(['once', 'interval', 'cron'] as const).map((kind) => <button type="button" key={kind} className={draft.triggerKind === kind ? 'active' : ''} onClick={() => update({ triggerKind: kind })}>{kind === 'once' ? '单次' : kind === 'interval' ? '固定间隔' : 'Cron'}</button>)}</div>
          <div className="settings-fields automation-fields">
            {draft.triggerKind === 'once' && <label>运行时间<input type="datetime-local" value={draft.runAt} onChange={(event) => update({ runAt: event.target.value })} /></label>}
            {draft.triggerKind === 'interval' && <div className="settings-grid"><label>间隔（分钟）<input type="number" min="1" step="1" value={draft.intervalMinutes} onChange={(event) => update({ intervalMinutes: event.target.value })} /></label><label>起算时间<input type="datetime-local" value={draft.anchorAt} onChange={(event) => update({ anchorAt: event.target.value })} /></label></div>}
            {draft.triggerKind === 'cron' && <div className="settings-grid"><label>Cron 表达式<input value={draft.cronExpression} onChange={(event) => update({ cronExpression: event.target.value })} /></label><label>IANA 时区<input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} /></label></div>}
            <div className="settings-grid"><label>重叠运行<select value={draft.concurrency} onChange={(event) => update({ concurrency: event.target.value as ScheduleDraft['concurrency'] })}><option value="skip">跳过新一轮（推荐）</option><option value="queue">最多排队一轮</option></select></label><label>离线错过<select value={draft.misfire} onChange={(event) => update({ misfire: event.target.value as ScheduleDraft['misfire'] })}><option value="fire_once">宽限期内补跑一次</option><option value="skip">直接跳过</option></select></label></div>
            {draft.misfire === 'fire_once' && <label>补跑宽限（小时）<input type="number" min="0" step="1" value={draft.graceHours} onChange={(event) => update({ graceHours: event.target.value })} /></label>}
          </div>
        </section>

        {displayError && <div className="settings-error automation-error" role="alert">{displayError}</div>}
        <div className="automation-editor-actions"><div>{selected && !creating && <><button type="button" disabled={busy} onClick={() => { setLocalError(''); void onRunNow(selected.id).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); }}>立即运行</button><button className="danger" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除自动化“${selected.name}”？运行历史会保留在数据库中。`)) void onDelete(selected.id).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); }}>删除</button></>}</div><button className="primary" type="button" disabled={busy} onClick={() => { setLocalError(''); try { void onSave(scheduleInputFromDraft(draft, providers, teams, sessions, selected && !creating ? selected : undefined)).then((saved) => { setCreating(false); onSelect(saved.id); }).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); } }}>{busy ? '保存中…' : '保存自动化'}</button></div>

        {selected && !creating && <section className="settings-section-card automation-history">
          <div className="settings-section-title with-meta"><div><h2>运行历史</h2><p>最近 100 次执行；等待批准的任务可在主界面完成授权。</p></div><span>{runs.length}</span></div>
          <div className="automation-run-list">{runs.map((run) => <ScheduleRunHistoryItem
            key={run.id}
            run={run}
            busy={busy}
            onCancel={async (runId) => {
              try { await onCancelRun(runId); }
              catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
            }}
          />)}{runs.length === 0 && <div className="automation-list-empty">还没有运行记录</div>}</div>
        </section>}
      </div>
    </div>}
  </div>;
}
