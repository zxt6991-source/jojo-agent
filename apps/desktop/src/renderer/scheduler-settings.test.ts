import { describe, expect, it } from 'vitest';
import type { ProviderConfig, SessionMeta } from '@desktop-agent/contracts';
import {
  createScheduleDraft,
  scheduleInputFromDraft,
  scheduleRunDeliveryLabel,
  scheduleRunDetails,
  scheduleTimingLabel
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
  models: ['gpt-5'],
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
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
        lane: { mode: 'dedicated' },
        budget: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 }
      },
      misfire: { kind: 'fire_once', graceMs: 86_400_000 },
      concurrency: 'skip'
    });
  });

  it('rejects an empty prompt before crossing IPC', () => {
    const draft = createScheduleDraft(sessions, providers);
    expect(() => scheduleInputFromDraft(draft, providers)).toThrow('请输入运行提示词');
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
