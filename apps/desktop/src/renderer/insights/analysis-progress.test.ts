import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InsightGenerateInput, InsightEvent, ConversationMapEvent } from '@desktop-agent/contracts';
import { AnalysisProgressPanel } from './AnalysisProgressPanel';
import { insightReducer } from './state';
import { conversationMapReducer } from '../conversation-map';
import { analysisCount, analysisSteps, analysisStepStatus } from './analysis-progress';

const request: InsightGenerateInput = { requestId: 'current', range: '30d', scope: { kind: 'personal_main' }, perspective: 'reverse_thinking' };
const progress = (phase: Extract<InsightEvent, { type: 'insight.progress' }>['phase'], detail: string) => ({ type: 'insight.progress' as const, requestId: request.requestId, phase, detail });

describe('analysis progress lifecycle', () => {
  it('preserves rapidly delivered stages, replaces batch counts and resets on retry', () => {
    let state = insightReducer({ status: 'idle' }, { type: 'start', request });
    const reading = progress('reading', '已读取 21 轮对话');
    const extracting = { ...progress('extracting', '已处理第 1 批'), completed: 1, total: 3 };
    const merging = progress('merging', '正在归并主题');
    for (const event of [reading, extracting, { ...extracting, completed: 3 }, merging]) state = insightReducer(state, { type: 'event', event });
    expect(state.progressHistory).toEqual({ reading, extracting: { ...extracting, completed: 3 }, merging });
    expect(state.progress).toEqual(merging);
    for (const reset of [insightReducer(state, { type: 'start', request: { ...request, requestId: 'next' } }),
      insightReducer(state, { type: 'cancel' }), insightReducer(state, { type: 'invalidate' })]) {
      expect(reset.progressHistory).toBeUndefined();
      expect(insightReducer(reset, { type: 'event', event: merging })).toBe(reset);
    }
  });

  it('replaces map rendering counts with final validation status and clears history on cancel', () => {
    let state = conversationMapReducer({ status: 'idle' }, { type: 'start', request });
    const event: Extract<ConversationMapEvent, { type: 'conversation-map.progress' }> = { type: 'conversation-map.progress', requestId: request.requestId,
      phase: 'rendering', completed: 2, total: 2, detail: '摘要已核对' };
    state = conversationMapReducer(state, { type: 'event', event });
    const validating = { type: 'conversation-map.progress' as const, requestId: request.requestId, phase: 'rendering' as const, detail: '正在核对引用' };
    state = conversationMapReducer(state, { type: 'event', event: validating });
    expect(state.progressHistory?.rendering).toEqual(validating);
    expect(analysisCount(state.progress)).toBe('');
    const cancelled = conversationMapReducer(state, { type: 'cancel' });
    expect(cancelled.progressHistory).toBeUndefined();
    expect(conversationMapReducer(cancelled, { type: 'event', event })).toBe(cancelled);
  });
});

describe('analysis process presentation', () => {
  it.each([
    ['reverse_thinking', '检验假设与反例'], ['second_order', '推演后续影响'], ['blind_spots', '寻找信息缺口'], ['conversation_map', '比较观点变化']
  ] as const)('explains the actual %s analysis operation', (perspective, label) => {
    const event = perspective === 'conversation_map'
      ? { type: 'conversation-map.progress' as const, requestId: 'current', phase: 'comparing' as const, detail: '正在处理主题' }
      : progress('analyzing', '正在分析所选内容');
    const html = renderToStaticMarkup(React.createElement(AnalysisProgressPanel, { perspective, progress: event }));
    expect(html).toContain(`<h2>${label}`);
    expect(html).toContain('aria-label="分析步骤"');
    expect(html).toContain('已用时 0 秒');
    expect(html).not.toContain('aria-valuenow');
  });

  it('never labels skipped extraction or synthesis as completed', () => {
    const steps = analysisSteps('blind_spots');
    const history = { reading: progress('reading', '已读取历史') };
    expect(analysisStepStatus('reading', 'validating', history, steps)).toBe('done');
    expect(analysisStepStatus('extracting', 'validating', history, steps)).toBe('skipped');
    expect(analysisStepStatus('analyzing', 'validating', history, steps)).toBe('skipped');
    expect(analysisStepStatus('validating', 'reading', {}, steps)).toBe('pending');
  });

  it('shows phase-local units, escapes details and leaves unknown duration indeterminate', () => {
    const event = { ...progress('extracting', '<script>bad()</script>'), completed: 2, total: 5 };
    const html = renderToStaticMarkup(React.createElement(AnalysisProgressPanel, { perspective: 'reverse_thinking', progress: event }));
    expect(html).toContain('2 / 5 批');
    expect(html).toContain('aria-valuemax="5" aria-valuenow="2"');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(analysisCount({ ...event, total: 0 })).toBe('');
    expect(analysisCount({ ...progress('reading', ''), completed: 21 })).toBe('已读取 21 轮对话');
    const unknown = renderToStaticMarkup(React.createElement(AnalysisProgressPanel, { perspective: 'reverse_thinking', progress: { ...progress('analyzing', '等待模型结果'), completed: 0, total: 1 } }));
    expect(unknown).not.toContain('aria-valuenow');
    expect(unknown).not.toContain('0 / 1');
  });
});
