import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopApi,
  ProviderConfig,
  SaveScheduleInputContract,
  ScheduleContract,
  ScheduleDeliveryItemContract,
  ScheduleRunContract,
  SessionMeta,
  SpeechPlaybackResult,
  SpeechSettings,
  TeamSnapshot
} from '@desktop-agent/contracts';
import { nextSpeechGeneration, useSpeechStatus } from './useSpeech';

type TriggerKind = 'once' | 'interval' | 'cron';
type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'completed';

export type ScheduleDraft = {
  name: string;
  description: string;
  enabled: boolean;
  targetKind: 'agent' | 'team_member' | 'workflow' | 'reminder';
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
  conversationEnabled: boolean;
  conversationSessionId: string;
  notificationEnabled: boolean;
  voiceEnabled: boolean;
  voiceContentKind: 'result' | 'fixed';
  voiceText: string;
  voiceMaxChars: string;
  voiceExpiryMinutes: string;
  voicePresetId: string;
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
  const reminderTarget = schedule?.target.kind === 'reminder' ? schedule.target : undefined;
  const voice = schedule?.delivery?.voice;
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
    targetKind: reminderTarget ? 'reminder' : workflowTarget ? 'workflow' : teamTarget ? 'team_member' : sessions.length === 0 ? 'reminder' : 'agent',
    triggerKind: spec?.kind ?? 'cron',
    runAt: localDateTime(spec?.kind === 'once' ? new Date(spec.runAt) : nextHour),
    intervalMinutes: spec?.kind === 'interval' ? String(spec.intervalMs / 60_000) : '60',
    anchorAt: localDateTime(spec?.kind === 'interval' ? new Date(spec.anchorAt) : now),
    cronExpression: spec?.kind === 'cron' ? spec.expression : '0 8 * * *',
    timezone: spec?.kind === 'cron' ? spec.timezone : defaultTimezone(),
    sessionId: target?.sessionId ?? teamTarget?.parentSessionId ?? workflowTarget?.sessionId ?? sessions[0]?.id ?? '',
    providerId: target?.providerId ?? teamTarget?.providerId ?? workflowTarget?.providerId ?? provider?.id ?? '',
    model: target?.model ?? teamTarget?.model ?? workflowTarget?.model ?? provider?.model ?? '',
    prompt: reminderTarget?.text ?? target?.input.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? teamTarget?.task ?? '',
    conversationEnabled: schedule?.delivery?.conversation?.enabled ?? false,
    conversationSessionId: schedule?.delivery?.conversation?.sessionId ?? target?.sessionId ?? sessions[0]?.id ?? '',
    notificationEnabled: schedule?.delivery?.notification?.enabled ?? false,
    voiceEnabled: voice?.enabled ?? false,
    voiceContentKind: voice?.content.kind ?? 'result',
    voiceText: voice?.content.kind === 'fixed' ? voice.content.text : '',
    voiceMaxChars: voice?.content.kind === 'result' ? String(voice.content.maxChars) : '200',
    voiceExpiryMinutes: voice ? String(voice.expiresAfterMs / 60_000) : '30',
    voicePresetId: voice?.presetId ?? '',
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
  if (!prompt) throw new Error(draft.targetKind === 'reminder' ? '请输入提醒内容。' : '请输入运行提示词。');
  if (draft.targetKind === 'reminder' && prompt.length > 200) throw new Error('提醒内容最多 200 字符。');
  const provider = providers.find((item) => item.id === draft.providerId);
  if (draft.targetKind !== 'reminder') {
    if (!draft.sessionId) throw new Error('请选择会话。');
    if (!draft.providerId || !draft.model) throw new Error('请选择 Provider 和模型。');
    if (!provider) throw new Error('所选 Provider 已不存在。');
    if (!provider.models.some((item) => item.id === draft.model)) throw new Error('所选模型不在 Provider 的可用模型中。');
  }
  if (draft.conversationEnabled && !draft.conversationSessionId) throw new Error('请选择结果投递的会话。');
  const voiceExpiryMinutes = Number(draft.voiceExpiryMinutes);
  const voiceMaxChars = Number(draft.voiceMaxChars);
  const voiceText = draft.voiceText.trim();
  if (draft.voiceEnabled) {
    if (!Number.isFinite(voiceExpiryMinutes) || voiceExpiryMinutes < 1 / 60 || voiceExpiryMinutes > 10_080) {
      throw new Error('播报有效期必须在 1 秒到 7 天之间。');
    }
    if (draft.voiceContentKind === 'fixed' && (!voiceText || voiceText.length > 200)) throw new Error('固定播报文案须为 1 到 200 字符。');
    if (draft.voiceContentKind === 'result' && (!Number.isInteger(voiceMaxChars) || voiceMaxChars < 1 || voiceMaxChars > 600)) throw new Error('播报结果长度须为 1 到 600 字符。');
  }
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
    target: draft.targetKind === 'reminder' ? { kind: 'reminder', text: prompt } : draft.targetKind === 'agent' ? {
        kind: 'agent',
        sessionId: draft.sessionId,
        providerId: draft.providerId,
        model: draft.model,
        input: { content: [{ type: 'text', text: prompt }] },
        lane: { mode: 'dedicated' }
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
    ...((schedule?.delivery || draft.conversationEnabled || draft.notificationEnabled || draft.voiceEnabled) ? {
      delivery: {
        ...schedule?.delivery,
        ...(draft.conversationSessionId ? { conversation: { enabled: draft.conversationEnabled, sessionId: draft.conversationSessionId } } : {}),
        ...(draft.notificationEnabled || schedule?.delivery?.notification ? { notification: { enabled: draft.notificationEnabled } } : {}),
        ...(draft.voiceEnabled ? { voice: {
          enabled: true, deviceId: 'local-desktop' as const,
          content: draft.voiceContentKind === 'fixed'
            ? { kind: 'fixed' as const, text: voiceText }
            : { kind: 'result' as const, maxChars: voiceMaxChars },
          expiresAfterMs: Math.round(voiceExpiryMinutes * 60_000),
          ...(draft.voicePresetId ? { presetId: draft.voicePresetId } : {})
        } } : schedule?.delivery?.voice ? { voice: { ...schedule.delivery.voice, enabled: false } } : {})
      }
    } : {}),
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
  run: Pick<ScheduleRunContract, 'deliveryStatus' | 'deliveryError' | 'deliveryItems'>
): string {
  if (run.deliveryItems?.length) return run.deliveryItems.map(scheduleDeliveryItemLabel).join(' · ');
  if (run.deliveryStatus === 'delivered') return '✓ 已发送至对话';
  if (run.deliveryStatus === 'failed') return `✕ 投递失败${run.deliveryError ? ` · ${run.deliveryError}` : ''}`;
  if (run.deliveryStatus === 'pending') return '投递中';
  if (run.deliveryStatus === 'skipped') return '未投递';
  return '旧任务 · 无投递记录';
}

export function scheduleDeliveryItemLabel(item: Pick<ScheduleDeliveryItemContract, 'destination' | 'state'>): string {
  const destination = ({ conversation: '对话', notification: '系统通知', voice: '语音', channel: 'Channel' })[item.destination];
  const state = ({
    pending: '待投递', preparing: '准备中', ready: '待播放', claimed: '等待播放确认',
    playing: '播放中', played: '已播完', delivered: '已投递', failed: '失败',
    suppressed: '已静音', expired: '已过期', uncertain: '播放结果不确定', interrupted: '已中断', cancelled: '已撤销'
  })[item.state];
  return `${destination}：${state}`;
}

const REPLAYABLE_VOICE_STATES = new Set<ScheduleDeliveryItemContract['state']>([
  'played', 'failed', 'suppressed', 'uncertain', 'interrupted'
]);

export function scheduleVoicePreviewAvailability(draft: ScheduleDraft, savedDraft: ScheduleDraft | undefined, speechEnabled: boolean): { canPreview: boolean; reason: string } {
  if (!savedDraft) return { canPreview: false, reason: '保存任务后可试听固定文案。' };
  if (JSON.stringify(draft) !== JSON.stringify(savedDraft)) return { canPreview: false, reason: '有尚未保存的修改，保存任务后再试听。' };
  if (!speechEnabled) return { canPreview: false, reason: '请先在语音设置中完成验证并启用。' };
  if (!draft.voiceEnabled) return { canPreview: false, reason: '请先开启语音播报并保存。' };
  if (draft.voiceContentKind === 'result' && draft.targetKind !== 'reminder') return { canPreview: false, reason: '任务完成后才能生成结果语音，可在运行历史中播放；试听不会执行任务。' };
  return { canPreview: true, reason: '试听已保存的文案和音色，会请求语音服务。' };
}

export function scheduleVoicePreparationLabel(state: Awaited<ReturnType<DesktopApi['getScheduleVoicePreparation']>>['state']): string {
  return ({ not_prepared: '语音尚未准备', preparing: '语音准备中…', ready: '语音已准备', failed: '语音准备失败', unavailable: '语音暂不可用', dynamic: '任务完成后准备结果语音' })[state];
}

function ScheduleVoicePreview({ api, schedule, draft, savedDraft, speechEnabled }: {
  api: DesktopApi; schedule: ScheduleContract | undefined; draft: ScheduleDraft; savedDraft: ScheduleDraft | undefined; speechEnabled: boolean;
}) {
  const [preparation, setPreparation] = useState<Awaited<ReturnType<DesktopApi['getScheduleVoicePreparation']>> | undefined>();
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [preview, setPreview] = useState<SpeechPlaybackResult | undefined>();
  const previewRef = useRef<SpeechPlaybackResult | undefined>(undefined);
  const epoch = useRef(0);
  const status = useSpeechStatus(api);
  const availability = scheduleVoicePreviewAvailability(draft, savedDraft, speechEnabled);
  const playback = status.playbacks.find(value => value.playbackId === preview?.playbackId);
  const playing = Boolean(preview && (!playback || ['queued', 'preparing', 'playing'].includes(playback.state)));
  const draftSignature = JSON.stringify(draft);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPreparation(undefined); setError('');
    const refresh = async () => {
      if (!schedule?.delivery?.voice?.enabled || !draft.voiceEnabled) return;
      try {
        const value = await api.getScheduleVoicePreparation({ scheduleId: schedule.id });
        if (live && value.revision === schedule.revision) setPreparation(value);
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (live) timer = setTimeout(() => void refresh(), 2_000); }
    };
    void refresh();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [api, schedule?.id, schedule?.revision, schedule?.delivery?.voice?.enabled, draft.voiceEnabled]);
  useEffect(() => {
    epoch.current += 1;
    setPreview(undefined); setPreparing(false);
    return () => {
      epoch.current += 1;
      const previous = previewRef.current;
      previewRef.current = undefined;
      if (previous) void api.stopSpeechPlayback(previous).catch(() => undefined);
    };
  }, [api, draftSignature]);
  const play = async () => {
    if (!schedule || !availability.canPreview || preparing) return;
    const current = epoch.current;
    setPreparing(true); setError('');
    try {
      const value = await api.previewScheduleVoice({ scheduleId: schedule.id, generation: nextSpeechGeneration() });
      if (current !== epoch.current) { void api.stopSpeechPlayback(value).catch(() => undefined); return; }
      previewRef.current = value; setPreview(value);
    } catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === epoch.current) setPreparing(false); }
  };
  const previewLabel = playback?.state === 'played' ? '本次试听已完成' : playback?.state === 'playing' ? '正在试听…' : playback?.state === 'suppressed' ? '本次试听已静音' : playback?.state === 'interrupted' ? '本次试听已停止' : playback?.state === 'failed' ? `试听失败${playback.reason ? `：${playback.reason}` : ''}` : preparing || preview ? '正在准备试听…' : '';
  return <div className="automation-voice-preview">
    {schedule?.delivery?.voice?.enabled && <div className={`automation-voice-preparation ${preparation?.state ?? ''}`} role="status"><span>{preparation ? scheduleVoicePreparationLabel(preparation.state) : '正在读取语音准备状态…'}</span>{preparation?.reason && <small>{preparation.reason}</small>}</div>}
    <div className="automation-voice-preview-actions"><button type="button" disabled={!availability.canPreview || preparing || playing} onClick={() => void play()}>试听已保存文案</button>{playing && <button type="button" onClick={() => { if (preview) void api.stopSpeechPlayback(preview).catch(cause => setError(String(cause))); }}>停止试听</button>}{previewLabel && <span role="status">{previewLabel}</span>}</div>
    <p className="automation-delivery-note">{availability.reason}</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}

function ScheduleRunHistoryItem({
  run,
  schedule,
  busy,
  onCancel,
  onOpenConversation,
  onReplayVoiceDelivery
}: {
  run: ScheduleRunContract;
  schedule: ScheduleContract;
  busy: boolean;
  onCancel(runId: string): Promise<void>;
  onOpenConversation(sessionId: string, messageId: string): void;
  onReplayVoiceDelivery?: ((itemId: string) => Promise<void>) | undefined;
}) {
  const details = scheduleRunDetails(run);
  const deliveredConversation = run.deliveryItems?.find((item) => item.destination === 'conversation' && item.state === 'delivered');
  const snapshotDelivery = run.deliverySnapshot?.delivery ?? schedule.delivery;
  const conversationSessionId = deliveredConversation?.destinationId ?? (snapshotDelivery?.conversation?.enabled
    ? snapshotDelivery.conversation.sessionId
    : undefined);
  const messageId = deliveredConversation?.payloadSnapshot.messageId ?? run.deliveryMessageId;
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
    {conversationSessionId && messageId && <button
      type="button"
      onClick={() => onOpenConversation(conversationSessionId, messageId)}
    >查看对话</button>}
    {run.deliveryItems?.length ? <ul className="automation-delivery-items" aria-label="各目的地投递状态">
      {run.deliveryItems.map((item) => <li key={item.id}>
        <span><strong>{scheduleDeliveryItemLabel(item)}</strong>
          {item.error && <small>{item.error}</small>}
          {item.destination === 'voice' && item.expiresAt && <small>有效至 {new Date(item.expiresAt).toLocaleString()}</small>}
        </span>
        {item.destination === 'voice' && REPLAYABLE_VOICE_STATES.has(item.state)
          && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) && onReplayVoiceDelivery && <button
          type="button" disabled={busy} onClick={() => void onReplayVoiceDelivery(item.id)}
        >重新播报</button>}
      </li>)}
    </ul> : null}
    {details?.kind === 'empty' && <p className="automation-run-empty">{details.content}</p>}
    {details && details.kind !== 'empty' && <details className={`automation-run-detail ${details.kind}`}>
      <summary>{details.label}</summary>
      <pre>{details.content}</pre>
    </details>}
  </article>;
}

export function SchedulerSettingsPage({
  sessions, providers, teams, schedules, selectedScheduleId, runs, busy, error,
  speechEnabled = false, voicePresets = [], api, onOpenSpeechSettings, onReplayVoiceDelivery,
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
  speechEnabled?: boolean;
  voicePresets?: SpeechSettings['voicePresets'];
  api?: DesktopApi;
  onOpenSpeechSettings?(): void;
  onReplayVoiceDelivery?: ((itemId: string) => Promise<void>) | undefined;
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
  const savedDraft = useMemo(() => selected && !creating ? createScheduleDraft(sessions, providers, teams, selected) : undefined, [sessions, providers, teams, selected, creating]);

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
    {!editing && <section className="automation-overview">
      <button className="automation-overview-create" type="button" disabled={busy} onClick={beginCreate}>创建</button>
      <div className="automation-overview-content">
        <header><h1>已安排的任务</h1><p>让 Jojo Agent 安排任务、设置提醒或定期执行工作。</p></header>
        {searchControl}
        {filterControls}
        {taskList}
      </div>
    </section>}
    {editing && <div className="automations-layout">
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
              <span className="sr-only">{draft.targetKind === 'reminder' ? '提醒内容' : '任务提示词'}</span>
              <textarea rows={4} maxLength={draft.targetKind === 'reminder' ? 200 : undefined} value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder={draft.targetKind === 'reminder' ? '到时提醒我的内容，例如：喝水，活动一下…' : '描述这个任务要完成的工作…'} />
            </label>

            <section className="automation-form-section">
              <h2>详情</h2>
              <div className="automation-row-card">
                <label><span>运行目标</span><select value={draft.targetKind} onChange={(event) => update({ targetKind: event.target.value as ScheduleDraft['targetKind'] })}><option value="reminder">固定提醒</option><option value="agent">Agent</option><option value="team_member">Team Member</option><option value="workflow">Workflow</option></select></label>
                {draft.targetKind !== 'reminder' && <>
                  <label><span>运行于</span><select value={draft.sessionId} onChange={(event) => { const session = sessions.find((item) => item.id === event.target.value); update({ sessionId: event.target.value, workingDirectory: session?.workingDirectory ?? '' }); }}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
                  <label><span>Provider</span><select value={draft.providerId} onChange={(event) => { const provider = providers.find((item) => item.id === event.target.value); update({ providerId: event.target.value, model: provider?.model ?? '' }); }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                  <label><span>模型</span><select value={draft.model} onChange={(event) => update({ model: event.target.value })}>{activeProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
                </>}
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
                <label className="automation-status-row"><span>状态</span><span><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => changeEnabled(event.target.checked)} /> {draft.enabled ? '已开启' : '已暂停'}</span></label>
              </div>
            </section>

            <section className="automation-form-section">
              <h2>提醒与投递</h2>
              <div className="automation-row-card">
                <label className="automation-check-row"><span>发送至对话</span><input type="checkbox" checked={draft.conversationEnabled} onChange={(event) => update({ conversationEnabled: event.target.checked })} /></label>
                {draft.conversationEnabled && <label><span>接收会话</span><select value={draft.conversationSessionId} onChange={(event) => update({ conversationSessionId: event.target.value })}><option value="">请选择会话</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
                <label className="automation-check-row"><span>系统通知</span><input type="checkbox" checked={draft.notificationEnabled} onChange={(event) => update({ notificationEnabled: event.target.checked })} /></label>
                <label className="automation-check-row"><span>语音播报</span><input type="checkbox" checked={draft.voiceEnabled} onChange={(event) => update({ voiceEnabled: event.target.checked })} /></label>
                {draft.voiceEnabled && <>
                  <label><span>播报音色</span><select value={draft.voicePresetId} onChange={event => update({ voicePresetId: event.target.value })}><option value="">默认声音</option>{voicePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}{draft.voicePresetId && !voicePresets.some(preset => preset.id === draft.voicePresetId) && <option value={draft.voicePresetId}>预设已不可用，请重新选择</option>}</select></label>
                  <label><span>播报内容</span><select value={draft.voiceContentKind} onChange={(event) => update({ voiceContentKind: event.target.value as ScheduleDraft['voiceContentKind'] })}><option value="result">{draft.targetKind === 'reminder' ? '提醒内容' : '已完成的任务结果'}</option><option value="fixed">固定文案</option></select></label>
                  {draft.voiceContentKind === 'result' && <label><span>最多播报字符</span><input type="number" min="1" max="600" step="1" value={draft.voiceMaxChars} onChange={(event) => update({ voiceMaxChars: event.target.value })} /></label>}
                  <label><span>超过多久不再补播</span><span className="automation-number-control"><input type="number" min="0.02" max="10080" step="1" value={draft.voiceExpiryMinutes} onChange={(event) => update({ voiceExpiryMinutes: event.target.value })} /> 分钟</span></label>
                </>}
              </div>
              {draft.voiceEnabled && draft.voiceContentKind === 'fixed' && <label className="automation-voice-copy">播报文案（最多 200 字符）<textarea rows={3} maxLength={200} value={draft.voiceText} onChange={(event) => update({ voiceText: event.target.value })} placeholder="到时直接朗读这段文字" /></label>}
              {draft.voiceEnabled && !speechEnabled && <p className="automation-delivery-note">语音尚未启用。保存任务后会记录播报状态；请先在语音设置中完成验证并启用。
                {onOpenSpeechSettings && <button type="button" onClick={onOpenSpeechSettings}>打开语音设置</button>}
              </p>}
              {draft.voiceEnabled && <p className="automation-delivery-note">仅在这台桌面设备播报。锁屏、勿扰或录音时保持安静；超过有效期不会自动补播。</p>}
              {draft.voiceEnabled && api && <ScheduleVoicePreview api={api} schedule={!creating ? selected ?? undefined : undefined} draft={draft} savedDraft={savedDraft} speechEnabled={speechEnabled} />}
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
              <div className="automation-history-title"><div><h2>运行历史</h2><p>最近 100 次执行，分别记录任务结果和每个目的地的投递状态。</p></div><span>{runs.length}</span></div>
              <div className="automation-run-list">{runs.map((run) => <ScheduleRunHistoryItem
                key={run.id}
                run={run}
                schedule={selected}
                busy={busy}
                onOpenConversation={onOpenConversation}
                onReplayVoiceDelivery={onReplayVoiceDelivery ? async (itemId) => {
                  try { await onReplayVoiceDelivery(itemId); }
                  catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
                } : undefined}
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
