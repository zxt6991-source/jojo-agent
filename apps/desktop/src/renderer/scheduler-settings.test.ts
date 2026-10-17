import { legacyModelConfig, SaveScheduleInputSchema } from '@desktop-agent/contracts';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig, SessionMeta } from '@desktop-agent/contracts';
import {
  createScheduleDraft,
  scheduleInputFromDraft,
  scheduleRunDeliveryLabel,
  scheduleRunDetails,
  scheduleDeliveryItemLabel,
  scheduleTimingLabel,
  scheduleVoicePreviewAvailability,
  scheduleVoicePreparationLabel
} from './SchedulerSettings';

const sessions: SessionMeta[] = [{
  id: 'session-1',
  title: 'Project',
  workingDirectory: '/workspace/project',
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z'
}];

const providers: ProviderConfig[] = [{
  id: 'openai',
  name: 'OpenAI',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  models: [legacyModelConfig('gpt-5', 128_000, 8_192)],
  hasApiKey: true
}];

describe('scheduler settings draft', () => {
  it('builds a cron Agent target with durable defaults', () => {
    const draft = createScheduleDraft(sessions, providers);
    draft.name = 'Daily review';
    draft.prompt = 'Review the current workspace changes.';
    draft.cronExpression = '0 8 * * *';
    draft.timezone = 'Asia/Shanghai';

    expect(scheduleInputFromDraft(draft, providers)).toEqual({
      name: 'Daily review',
      enabled: true,
      spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
      target: {
        kind: 'agent',
        sessionId: 'session-1',
        providerId: 'openai',
        model: 'gpt-5',
        input: { content: [{ type: 'text', text: 'Review the current workspace changes.' }] },
        lane: { mode: 'dedicated' }
      },
      misfire: { kind: 'fire_once', graceMs: 86_400_000 },
      concurrency: 'skip'
    });
  });

  it('rejects an empty prompt before crossing IPC', () => {
    const draft = createScheduleDraft(sessions, providers);
    expect(() => scheduleInputFromDraft(draft, providers)).toThrow('请输入运行提示词');
  });

  it('creates a fixed reminder without a session, model, provider or project', () => {
    const draft = createScheduleDraft([], []);
    draft.name = '喝水';
    draft.prompt = '该喝水了';
    draft.notificationEnabled = true;
    draft.voiceEnabled = true;
    const input = scheduleInputFromDraft(draft, []);
    expect(SaveScheduleInputSchema.safeParse(input).success).toBe(true);
    expect(input.target).toEqual({ kind: 'reminder', text: '该喝水了' });
    expect(input.delivery).toEqual({
      notification: { enabled: true },
      voice: { enabled: true, deviceId: 'local-desktop', content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 1_800_000 }
    });
  });

  it('validates reminder and voice content limits before IPC', () => {
    const draft = createScheduleDraft([], []);
    draft.prompt = 'x'.repeat(201);
    expect(() => scheduleInputFromDraft(draft, [])).toThrow('提醒内容最多 200 字符');
    draft.prompt = '喝水';
    draft.voiceEnabled = true;
    draft.voiceContentKind = 'fixed';
    expect(() => scheduleInputFromDraft(draft, [])).toThrow('固定播报文案');
    draft.voiceText = '现在该喝水了';
    draft.voiceExpiryMinutes = '10081';
    expect(() => scheduleInputFromDraft(draft, [])).toThrow('播报有效期');
    draft.voiceExpiryMinutes = '30';
    expect(scheduleInputFromDraft(draft, []).delivery?.voice?.content).toEqual({ kind: 'fixed', text: '现在该喝水了' });
  });

  it('round-trips a selected voice preset and can deliberately return to the default voice', () => {
    const draft = createScheduleDraft([], []);
    draft.prompt = '喝水'; draft.voiceEnabled = true; draft.voicePresetId = 'work';
    const input = scheduleInputFromDraft(draft, []);
    expect(input.delivery?.voice?.presetId).toBe('work');
    const schedule = { ...input, enabled: true, concurrency: 'skip' as const, misfire: { kind: 'skip' as const }, id: 'schedule-1', revision: 2, createdBy: 'user', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z' };
    const savedDraft = createScheduleDraft([], [], [], schedule);
    expect(savedDraft.voicePresetId).toBe('work');
    savedDraft.voicePresetId = '';
    expect(scheduleInputFromDraft(savedDraft, [], [], [], schedule).delivery?.voice).not.toHaveProperty('presetId');
  });

  it('previews only saved fixed speech and never executes an Agent to obtain sample result audio', () => {
    const draft = createScheduleDraft([], []);
    draft.prompt = '喝水'; draft.voiceEnabled = true;
    expect(scheduleVoicePreviewAvailability(draft, undefined, true).canPreview).toBe(false);
    expect(scheduleVoicePreviewAvailability(draft, { ...draft }, false).canPreview).toBe(false);
    expect(scheduleVoicePreviewAvailability(draft, { ...draft }, true).canPreview).toBe(true);
    expect(scheduleVoicePreviewAvailability({ ...draft, voicePresetId: 'new-preset' }, draft, true)).toEqual({ canPreview: false, reason: '有尚未保存的修改，保存任务后再试听。' });
    const dynamic = { ...draft, targetKind: 'agent' as const };
    expect(scheduleVoicePreviewAvailability(dynamic, { ...dynamic }, true)).toEqual({ canPreview: false, reason: '任务完成后才能生成结果语音，可在运行历史中播放；试听不会执行任务。' });
    const fixed = { ...dynamic, voiceContentKind: 'fixed' as const, voiceText: '工作完成了' };
    expect(scheduleVoicePreviewAvailability(fixed, { ...fixed }, true).canPreview).toBe(true);
  });

  it('distinguishes prepared assets from preparation failure and unavailable speech', () => {
    expect(scheduleVoicePreparationLabel('ready')).toBe('语音已准备');
    expect(scheduleVoicePreparationLabel('preparing')).toBe('语音准备中…');
    expect(scheduleVoicePreparationLabel('failed')).toBe('语音准备失败');
    expect(scheduleVoicePreparationLabel('unavailable')).toBe('语音暂不可用');
    expect(scheduleVoicePreparationLabel('dynamic')).toBe('任务完成后准备结果语音');
  });

  it('preserves configured channels and the receiving conversation when editing', () => {
    const draft = createScheduleDraft(sessions, providers);
    draft.prompt = 'Review';
    const input = scheduleInputFromDraft(draft, providers);
    const schedule = {
      ...input, id: 'schedule-1', revision: 3, createdBy: 'user', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      enabled: true, concurrency: 'skip' as const, misfire: { kind: 'skip' as const },
      delivery: { conversation: { enabled: true, sessionId: 'session-1' }, channels: [{ enabled: true, bindingId: 'binding-1', mode: 'full' as const }] }
    };
    const updatedDraft = createScheduleDraft(sessions, providers, [], schedule);
    updatedDraft.prompt = 'Updated review';
    expect(scheduleInputFromDraft(updatedDraft, providers, [], sessions, schedule).delivery).toEqual(schedule.delivery);
  });

  it('builds a saved Workflow target with JSON args', () => {
    const draft = createScheduleDraft(sessions, providers);
    draft.name = 'Architecture review';
    draft.prompt = 'Run workflow';
    draft.targetKind = 'workflow';
    draft.workflowKind = 'saved';
    draft.workflowName = 'architecture-review';
    draft.workflowArgs = '{"focus":"scheduler"}';
    const input = scheduleInputFromDraft(draft, providers, [], sessions);
    expect(input.target).toEqual({
      kind: 'workflow',
      sessionId: 'session-1',
      workingDirectory: '/workspace/project',
      providerId: 'openai',
      model: 'gpt-5',
      workflow: { kind: 'saved', name: 'architecture-review', args: { focus: 'scheduler' } }
    });
  });

  it('exposes persisted run output and distinguishes empty completions from errors', () => {
    expect(scheduleRunDetails({ status: 'completed', resultPreview: 'scheduled answer' })).toEqual({
      kind: 'result', label: '查看结果', content: 'scheduled answer'
    });
    expect(scheduleRunDetails({ status: 'completed' })).toEqual({
      kind: 'empty', label: '执行结果', content: '执行已完成，但没有产生文本输出。'
    });
    expect(scheduleRunDetails({ status: 'failed', error: 'provider failed' })).toEqual({
      kind: 'error', label: '查看错误详情', content: 'provider failed'
    });
  });

  it('presents delivery state separately from execution output', () => {
    expect(scheduleRunDeliveryLabel({ deliveryStatus: 'delivered' })).toBe('✓ 已发送至对话');
    expect(scheduleRunDeliveryLabel({ deliveryStatus: 'failed', deliveryError: 'disk full' }))
      .toBe('✕ 投递失败 · disk full');
    expect(scheduleRunDeliveryLabel({ deliveryStatus: 'skipped' })).toBe('未投递');
    expect(scheduleRunDeliveryLabel({})).toBe('旧任务 · 无投递记录');
  });

  it('shows queued, playing, acknowledged and uncertain voice delivery distinctly', () => {
    expect(scheduleDeliveryItemLabel({ destination: 'voice', state: 'ready' })).toBe('语音：待播放');
    expect(scheduleDeliveryItemLabel({ destination: 'voice', state: 'claimed' })).toBe('语音：等待播放确认');
    expect(scheduleDeliveryItemLabel({ destination: 'voice', state: 'playing' })).toBe('语音：播放中');
    expect(scheduleDeliveryItemLabel({ destination: 'voice', state: 'played' })).toBe('语音：已播完');
    expect(scheduleDeliveryItemLabel({ destination: 'voice', state: 'uncertain' })).toBe('语音：播放结果不确定');
    expect(scheduleDeliveryItemLabel({ destination: 'conversation', state: 'delivered' })).toBe('对话：已投递');
  });

  it('formats common cron schedules like the scheduled-task list', () => {
    const base = {
      id: 'schedule-1', name: 'Daily', enabled: true,
      target: {
        kind: 'agent' as const, sessionId: 'session-1', providerId: 'openai', model: 'gpt-5',
        input: { content: [{ type: 'text' as const, text: 'Run' }] }
      },
      misfire: { kind: 'skip' as const }, concurrency: 'skip' as const, revision: 1,
      createdBy: 'user', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
    };
    expect(scheduleTimingLabel({
      ...base, spec: { kind: 'cron', expression: '0 8 * * 1-5', timezone: 'Asia/Shanghai' }
    })).toBe('工作日 08:00');
    expect(scheduleTimingLabel({
      ...base, spec: { kind: 'cron', expression: '0 16 * * 5', timezone: 'Asia/Shanghai' }
    })).toBe('星期五 16:00');
  });
});
