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
type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'completed';

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

function isCompletedSchedule(schedule: ScheduleContract): boolean {
  return schedule.spec.kind === 'once' && !schedule.enabled && !schedule.nextRunAt;
}

export function scheduleTimingLabel(schedule: ScheduleContract): string {
  if (schedule.spec.kind === 'once') return new Date(schedule.spec.runAt).toLocaleString();
  if (schedule.spec.kind === 'interval') {
    const minutes = schedule.spec.intervalMs / 60_000;
    return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  const [minute, hour, day, month, weekday] = schedule.spec.expression.trim().split(/\s+/);
  if (minute !== undefined && hour !== undefined && day === '*' && month === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (weekday === '1-5') return `工作日 ${time}`;
    if (weekday === '*') return `每天 ${time}`;
    const weekdayName = ({ '0': '星期日', '1': '星期一', '2': '星期二', '3': '星期三', '4': '星期四', '5': '星期五', '6': '星期六', '7': '星期日' })[weekday ?? ''];
    if (weekdayName) return `${weekdayName} ${time}`;
  }
  return triggerLabel(schedule);
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

export function scheduleRunDeliveryLabel(
  run: Pick<ScheduleRunContract, 'deliveryStatus' | 'deliveryError'>
): string {
  if (run.deliveryStatus === 'delivered') return '✓ 已发送至对话';
  if (run.deliveryStatus === 'failed') return `✕ 投递失败${run.deliveryError ? ` · ${run.deliveryError}` : ''}`;
  if (run.deliveryStatus === 'pending') return '投递中';
  if (run.deliveryStatus === 'skipped') return '未投递';
  return '旧任务 · 无投递记录';
}

function ScheduleRunHistoryItem({
  run,
  schedule,
  busy,
  onCancel,
  onOpenConversation
}: {
  run: ScheduleRunContract;
  schedule: ScheduleContract;
  busy: boolean;
  onCancel(runId: string): Promise<void>;
  onOpenConversation(sessionId: string, messageId: string): void;
}) {
  const details = scheduleRunDetails(run);
  const conversationSessionId = schedule.delivery?.conversation?.enabled
    ? schedule.delivery.conversation.sessionId
    : undefined;
  const deliveryLabel = scheduleRunDeliveryLabel(run);
  return <article>
    <span className={`automation-run-state ${run.status}`}>{runStateLabel(run.status)}</span>
    <div>
      <strong>{new Date(run.scheduledFor).toLocaleString()}</strong>
      <small>{run.trigger === 'manual' ? '手动运行' : run.trigger === 'misfire' ? '离线补跑' : '定时触发'} · {deliveryLabel}</small>
    </div>
    <time>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}</time>
    {ACTIVE_STATES.has(run.status) && <button type="button" disabled={busy} onClick={() => void onCancel(run.id)}>
      取消
    </button>}
    {conversationSessionId && run.deliveryMessageId && <button
      type="button"
      onClick={() => onOpenConversation(conversationSessionId, run.deliveryMessageId!)}
    >查看对话</button>}
    {details?.kind === 'empty' && <p className="automation-run-empty">{details.content}</p>}
    {details && details.kind !== 'empty' && <details className={`automation-run-detail ${details.kind}`}>
      <summary>{details.label}</summary>
      <pre>{details.content}</pre>
    </details>}
  </article>;
}

export function SchedulerSettingsPage({
  sessions, providers, teams, schedules, selectedScheduleId, runs, busy, error,
  onSelect, onClose, onRefresh, onSave, onDelete, onEnabled, onRunNow, onCancelRun, onOpenConversation
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
  onClose(): void;
  onRefresh(): void;
  onSave(input: SaveScheduleInput): Promise<ScheduleContract>;
  onDelete(scheduleId: string): Promise<void>;
  onEnabled(schedule: ScheduleContract, enabled: boolean): Promise<ScheduleContract>;
  onRunNow(scheduleId: string): Promise<ScheduleRunContract>;
  onCancelRun(runId: string): Promise<void>;
  onOpenConversation(sessionId: string, messageId: string): void;
}) {
  const selected = useMemo(
    () => schedules.find((schedule) => schedule.id === selectedScheduleId) ?? null,
    [schedules, selectedScheduleId]
  );
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(() => createScheduleDraft(sessions, providers, teams));
  const [localError, setLocalError] = useState('');
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setDraft(createScheduleDraft(sessions, providers, teams, creating ? undefined : selected ?? undefined));
    setLocalError('');
  }, [sessions, providers, teams, selected, creating]);

  const activeProvider = providers.find((provider) => provider.id === draft.providerId) ?? providers[0];
  const activeTeam = teams.find((team) => team.id === draft.teamId) ?? teams[0];
  const displayError = localError || error;
  const update = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const filteredSchedules = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return schedules.filter((schedule) => {
      const completed = isCompletedSchedule(schedule);
      if (filter === 'enabled' && !schedule.enabled) return false;
      if (filter === 'paused' && (schedule.enabled || completed)) return false;
      if (filter === 'completed' && !completed) return false;
      return !query || `${schedule.name} ${schedule.description ?? ''} ${triggerLabel(schedule)}`.toLocaleLowerCase().includes(query);
    });
  }, [filter, schedules, search]);

  const beginCreate = () => {
    setCreating(true);
    setDraft(createScheduleDraft(sessions, providers, teams));
    setLocalError('');
  };
  const closeEditor = () => {
    setCreating(false);
    setLocalError('');
    onClose();
  };
  const saveDraft = () => {
    setLocalError('');
    try {
      void onSave(scheduleInputFromDraft(draft, providers, teams, sessions, selected && !creating ? selected : undefined))
        .then((saved) => { setCreating(false); onSelect(saved.id); })
        .catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const deleteSelected = () => {
    if (!selected || !window.confirm(`删除自动化“${selected.name}”？运行历史会保留在数据库中。`)) return;
    void onDelete(selected.id).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)));
  };
  const changeEnabled = (enabled: boolean) => {
    update({ enabled });
    if (!selected || creating) return;
    void onEnabled(selected, enabled).catch((cause) => {
      update({ enabled: selected.enabled });
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const editing = creating || selected !== null;
  const editorStatus = creating ? '创建任务' : selected?.enabled ? '已开启' : selected && isCompletedSchedule(selected) ? '已完成' : '已暂停';
  const filterControls = <div className="automation-filter-tabs" role="tablist" aria-label="任务状态筛选">
    {([['all', '全部'], ['enabled', '已开启'], ['paused', '已暂停'], ['completed', '已完成']] as const).map(([value, label]) => <button
      key={value}
      type="button"
      role="tab"
      aria-selected={filter === value}
      className={filter === value ? 'active' : ''}
      onClick={() => setFilter(value)}
    >{label}</button>)}
  </div>;
  const searchControl = <label className="automation-search">
    <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已安排任务" />
  </label>;
  const taskList = <div className="automation-list">
    {filteredSchedules.map((schedule) => <button key={schedule.id} type="button" className={!creating && selected?.id === schedule.id ? 'active' : ''} onClick={() => { setCreating(false); onSelect(schedule.id); }}>
      <span className={`automation-play-icon ${schedule.enabled ? 'enabled' : ''}`} aria-hidden="true"><span /></span>
      <span><strong>{schedule.name}</strong><small>{scheduleTimingLabel(schedule)}</small></span>
      <span className="automation-list-more" aria-hidden="true">•••</span>
    </button>)}
    {filteredSchedules.length === 0 && <div className="automation-list-empty">{schedules.length === 0 ? '尚未创建任务' : '没有符合条件的任务'}</div>}
  </div>;

  return <div className="settings-content automations-settings-page">
    {sessions.length === 0 && <div className="automation-empty automation-page-empty"><strong>请先创建会话</strong><span>自动化需要一个会话来确定工作区与持久上下文。</span></div>}
    {sessions.length > 0 && !editing && <section className="automation-overview">
      <button className="automation-overview-create" type="button" disabled={busy} onClick={beginCreate}>创建</button>
      <div className="automation-overview-content">
        <header><h1>已安排的任务</h1><p>让 Jojo Agent 安排任务、设置提醒或定期执行工作。</p></header>
        {searchControl}
        {filterControls}
        {taskList}
      </div>
    </section>}
    {sessions.length > 0 && editing && <div className="automations-layout">
      <aside className="automation-browser" aria-label="自动化列表">
        <div className="automation-browser-toolbar">
          {filterControls}
          <button className="automation-create-button" type="button" disabled={busy} onClick={beginCreate}>创建 <span aria-hidden="true">⌄</span></button>
        </div>
        {searchControl}
        {taskList}
      </aside>

      <main className="automation-editor">
        <>
          <header className="automation-editor-header">
            <div><span>{editorStatus}</span><input className="automation-title-input" aria-label="任务名称" value={draft.name} onChange={(event) => update({ name: event.target.value })} /></div>
            <div className="automation-header-actions">
              <button type="button" title="刷新" aria-label="刷新" disabled={busy} onClick={onRefresh}>↻</button>
              {selected && !creating && <button type="button" title="立即运行" aria-label="立即运行" disabled={busy} onClick={() => { setLocalError(''); void onRunNow(selected.id).catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause))); }}>▷</button>}
              {selected && !creating && <button type="button" title="删除任务" aria-label="删除任务" disabled={busy} onClick={deleteSelected}>•••</button>}
              <button type="button" title="关闭详情" aria-label="关闭详情" onClick={closeEditor}>×</button>
            </div>
          </header>

          <div className="automation-editor-scroll">
            <label className="automation-prompt-card">
              <span className="sr-only">任务提示词</span>
              <textarea rows={4} value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="描述这个任务要完成的工作…" />
            </label>

            <section className="automation-form-section">
              <h2>详情</h2>
              <div className="automation-row-card">
                <label><span>运行于</span><select value={draft.sessionId} onChange={(event) => { const session = sessions.find((item) => item.id === event.target.value); update({ sessionId: event.target.value, workingDirectory: session?.workingDirectory ?? '' }); }}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
                <label><span>运行目标</span><select value={draft.targetKind} onChange={(event) => update({ targetKind: event.target.value as ScheduleDraft['targetKind'] })}><option value="agent">Agent</option><option value="team_member">Team Member</option><option value="workflow">Workflow</option></select></label>
                <label><span>Provider</span><select value={draft.providerId} onChange={(event) => { const provider = providers.find((item) => item.id === event.target.value); update({ providerId: event.target.value, model: provider?.model ?? '' }); }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                <label><span>模型</span><select value={draft.model} onChange={(event) => update({ model: event.target.value })}>{activeProvider?.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
                {draft.targetKind === 'team_member' && <>
                  <label><span>团队</span><select value={draft.teamId} onChange={(event) => { const team = teams.find((item) => item.id === event.target.value); update({ teamId: event.target.value, memberId: team?.members[0]?.id ?? '' }); }}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                  <label><span>成员</span><select value={draft.memberId} onChange={(event) => update({ memberId: event.target.value })}>{activeTeam?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
                </>}
                {draft.targetKind === 'workflow' && <>
                  <label><span>Workflow 来源</span><select value={draft.workflowKind} onChange={(event) => update({ workflowKind: event.target.value as ScheduleDraft['workflowKind'] })}><option value="saved">Saved Workflow</option><option value="inline">Inline Definition</option></select></label>
                  {draft.workflowKind === 'saved' && <label><span>Workflow 名称</span><input value={draft.workflowName} onChange={(event) => update({ workflowName: event.target.value })} placeholder="code-review" /></label>}
                </>}
              </div>
              {draft.targetKind === 'workflow' && <div className="automation-json-fields">
                {draft.workflowKind === 'inline' && <label>Workflow Definition（JSON）<textarea rows={7} value={draft.workflowDefinition} onChange={(event) => update({ workflowDefinition: event.target.value })} /></label>}
                <label>Workflow Args（JSON 对象）<textarea rows={3} value={draft.workflowArgs} onChange={(event) => update({ workflowArgs: event.target.value })} /></label>
              </div>}
            </section>

            <section className="automation-form-section">
              <h2>频率</h2>
              <div className="automation-row-card">
                <label><span>重复</span><select value={draft.triggerKind} onChange={(event) => update({ triggerKind: event.target.value as TriggerKind })}><option value="once">单次</option><option value="interval">固定间隔</option><option value="cron">Cron</option></select></label>
                {draft.triggerKind === 'once' && <label><span>运行时间</span><input type="datetime-local" value={draft.runAt} onChange={(event) => update({ runAt: event.target.value })} /></label>}
                {draft.triggerKind === 'interval' && <><label><span>间隔（分钟）</span><input type="number" min="1" step="1" value={draft.intervalMinutes} onChange={(event) => update({ intervalMinutes: event.target.value })} /></label><label><span>起算时间</span><input type="datetime-local" value={draft.anchorAt} onChange={(event) => update({ anchorAt: event.target.value })} /></label></>}
                {draft.triggerKind === 'cron' && <><label><span>Cron 表达式</span><input value={draft.cronExpression} onChange={(event) => update({ cronExpression: event.target.value })} /></label><label><span>时区</span><input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} /></label></>}
                <label><span>重叠运行</span><select value={draft.concurrency} onChange={(event) => update({ concurrency: event.target.value as ScheduleDraft['concurrency'] })}><option value="skip">跳过新一轮</option><option value="queue">最多排队一轮</option></select></label>
                <label><span>离线错过</span><select value={draft.misfire} onChange={(event) => update({ misfire: event.target.value as ScheduleDraft['misfire'] })}><option value="fire_once">宽限期内补跑</option><option value="skip">直接跳过</option></select></label>
                {draft.misfire === 'fire_once' && <label><span>补跑宽限</span><span className="automation-number-control"><input type="number" min="0" step="1" value={draft.graceHours} onChange={(event) => update({ graceHours: event.target.value })} /> 小时</span></label>}
                <label><span>结果投递</span><output>{selected?.delivery?.conversation?.enabled ? '创建任务的对话' : creating ? '静默（可从对话创建以自动投递）' : '静默'}</output></label>
                <label className="automation-status-row"><span>状态</span><span><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => changeEnabled(event.target.checked)} /> {draft.enabled ? '已开启' : '已暂停'}</span></label>
              </div>
            </section>

            <section className="automation-form-section">
              <h2>说明</h2>
              <input className="automation-description-input" value={draft.description} onChange={(event) => update({ description: event.target.value })} placeholder="添加可选说明" />
            </section>

            {displayError && <div className="settings-error automation-error" role="alert">{displayError}</div>}
            <div className="automation-editor-actions">
              <div>{selected && !creating && <button className="danger" type="button" disabled={busy} onClick={deleteSelected}>删除任务</button>}</div>
              <button className="primary" type="button" disabled={busy} onClick={saveDraft}>{busy ? '保存中…' : creating ? '创建任务' : '保存更改'}</button>
            </div>

            {selected && !creating && <section className="automation-history">
              <div className="automation-history-title"><div><h2>运行历史</h2><p>最近 100 次执行，结果与对话投递状态分开记录。</p></div><span>{runs.length}</span></div>
              <div className="automation-run-list">{runs.map((run) => <ScheduleRunHistoryItem
                key={run.id}
                run={run}
                schedule={selected}
                busy={busy}
                onOpenConversation={onOpenConversation}
                onCancel={async (runId) => {
                  try { await onCancelRun(runId); }
                  catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
                }}
              />)}{runs.length === 0 && <div className="automation-list-empty">还没有运行记录</div>}</div>
            </section>}
          </div>
        </>
      </main>
    </div>}
  </div>;
}
