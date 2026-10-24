import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationMapGenerateInput, ConversationMapResult, ConversationTopic } from '@desktop-agent/contracts';
import { ConversationMapPage } from './ConversationMapPage';
import { conversationFlowchart, conversationMapReducer, conversationMapSelectionKey, conversationMindmap, mermaidLabel, orderedSteps, type ConversationMapViewState } from './conversation-map';

const reference = { sessionId: 'session-1', entryId: 'entry-1', seq: 1, createdAt: '2026-10-20T10:00:00.000Z', role: 'user' as const };
const topic: ConversationTopic = {
  id: 'untrusted id\nclick n0 "javascript:alert(1)"', title: '桌面设置', summary: '讨论界面布局', keywords: ['设置'], subtopics: ['导航'],
  steps: [
    { id: 'answer', topicId: 'topic-1', kind: 'answer', occurredAt: '2026-10-20T10:01:00.000Z', text: '建议两栏布局', references: [{ ...reference, entryId: 'entry-2', seq: 2, role: 'assistant' }] },
    { id: 'question', topicId: 'topic-1', kind: 'question', occurredAt: reference.createdAt, text: '如何安排设置界面？', references: [reference] }
  ],
  links: [{ from: 'question', to: 'answer', relation: 'sequence' }]
};
const result: ConversationMapResult = {
  version: 1, generatedAt: '2026-10-23T10:00:00.000Z', rangeStart: '2026-09-23T10:00:00.000Z', rangeEnd: '2026-10-23T10:00:00.000Z', scopeKind: 'project', analyzedTurnCount: 1, analyzedSessionCount: 1, truncated: false, topics: [topic]
};
const request: ConversationMapGenerateInput = { requestId: 'request-1', range: '30d', scope: { kind: 'project', workingDirectory: '/project' }, currentSessionId: 'session-1' };

function start(previous: ConversationMapViewState = { status: 'idle' }) { return conversationMapReducer(previous, { type: 'start', request }); }
function complete(previous = start()) { return conversationMapReducer(previous, { type: 'event', event: { type: 'conversation-map.completed', requestId: request.requestId, result } }); }

describe('conversation map safe deterministic diagrams', () => {
  it('uses program-generated node IDs, never model IDs, with bounded escaped plain labels', () => {
    const poison = '<script>alert(1)</script>\n"]\nclick n0 "javascript:alert(1)"\n%%{init:{securityLevel:"loose"}}%%<img src=x onerror=alert(1)>`\\';
    const escaped = mermaidLabel(poison);
    expect(escaped).not.toMatch(/[<>"\n`\\[\]{}()]/u);
    expect(escaped).not.toContain('%%');
    expect(escaped).toContain('#34;');
    expect(mermaidLabel('🙂'.repeat(200))).toHaveLength(320);
    const mindmap = conversationMindmap({ ...result, topics: [{ ...topic, title: poison, subtopics: [poison] }] });
    expect(mindmap.split('\n')).toHaveLength(4);
    expect(mindmap).not.toContain(topic.id);
    expect(mindmap).not.toContain('<script>');
    expect(mindmap).toMatch(/t0\["/u);
    const diagram = conversationFlowchart({ ...topic, steps: topic.steps.map((step) => ({ ...step, text: poison })) });
    expect(diagram).not.toContain(topic.id);
    expect(diagram).not.toContain('securityLevel:"loose"');
    expect(diagram).not.toMatch(/^\s*click /mu);
  });

  it('sorts by source time, distinguishes AI suggestions and preserves explicit related relationships', () => {
    const before = topic.steps.map((step) => step.id);
    const ordered = orderedSteps(topic);
    expect(ordered.map((step) => step.id)).toEqual(['question', 'answer']);
    expect(topic.steps.map((step) => step.id)).toEqual(before);
    const diagram = conversationFlowchart({ ...topic, links: [{ from: 'question', to: 'answer', relation: 'related' }] });
    expect(diagram).toContain('n0["用户提出：如何安排设置界面？"]:::question');
    expect(diagram).toContain('n1["AI 观点 / 建议：建议两栏布局"]:::answer');
    expect(diagram).toContain('n0 -.-|相关讨论| n1');
    expect(diagram).not.toContain('-->');
  });

  it('does not invent edges for chronological lists or emit dangling/self links', () => {
    const diagram = conversationFlowchart({ ...topic, links: [{ from: 'missing', to: 'answer', relation: 'sequence' }, { from: 'question', to: 'question', relation: 'revision' }] });
    expect(diagram).not.toContain('-->');
    expect(diagram).not.toContain('missing');
  });
});

describe('conversation map lifecycle', () => {
  it('ignores completion after cancellation and events from older requests', () => {
    const running = start();
    const cancelled = conversationMapReducer(running, { type: 'cancel' });
    expect(complete(cancelled)).toBe(cancelled);
    const newer = conversationMapReducer(running, { type: 'start', request: { ...request, requestId: 'request-2' } });
    expect(complete(newer)).toBe(newer);
    expect(conversationMapReducer(newer, { type: 'event', event: { type: 'conversation-map.progress', requestId: request.requestId, phase: 'extracting' } })).toBe(newer);
  });

  it('retains a visibly identifiable old result across retry, failure and cancellation', () => {
    const completed = complete();
    expect(completed.result?.request).toBe(request);
    const running = start(completed);
    expect(running.result?.value).toBe(result);
    const failed = conversationMapReducer(running, { type: 'event', event: { type: 'conversation-map.failed', requestId: request.requestId, code: 'history_limit', message: '请缩小范围' } });
    expect(failed.status).toBe('failed');
    expect(failed.result?.value).toBe(result);
    expect(failed.error).toBe('请缩小范围');
    expect(start(failed).error).toBeUndefined();
    expect(conversationMapReducer(running, { type: 'cancel' }).result?.value).toBe(result);
  });

  it('supports reading/extracting/merging progress and terminal empty results', () => {
    let state = start();
    for (const phase of ['reading', 'extracting', 'merging', 'rendering'] as const) {
      state = conversationMapReducer(state, { type: 'event', event: { type: 'conversation-map.progress', requestId: request.requestId, phase, completed: 1, total: 3 } });
      expect(state.progress?.phase).toBe(phase);
      expect(state.status).toBe('running');
    }
    state = conversationMapReducer(state, { type: 'event', event: { type: 'conversation-map.completed', requestId: request.requestId, result: { ...result, topics: [], analyzedTurnCount: 0 } } });
    expect(state.status).toBe('completed');
    expect(state.result?.value.topics).toEqual([]);
    expect(state.activeRequestId).toBeUndefined();
  });

  it('recognizes stale project/range/scope changes without making same-project session changes stale', () => {
    const original = conversationMapSelectionKey(request);
    expect(conversationMapSelectionKey({ ...request, range: '7d' })).not.toBe(original);
    expect(conversationMapSelectionKey({ ...request, scope: { kind: 'project', workingDirectory: '/another' } })).not.toBe(original);
    expect(conversationMapSelectionKey({ ...request, scope: { kind: 'personal_main' } })).not.toBe(original);
    expect(conversationMapSelectionKey({ ...request })).toBe(original);
  });
});

describe('conversation map entry page', () => {
  const api = { generateConversationMap: vi.fn(), cancelConversationMap: vi.fn(), getConversationMapSource: vi.fn(), onConversationMapEvent: vi.fn(() => () => undefined) };
  const props = { api, onOpenSource: vi.fn(), onOpenModelSettings: vi.fn() };
  it('defaults to 30 days, discloses model usage, and keeps generation manual', () => {
    const html = renderToStaticMarkup(React.createElement(ConversationMapPage, { ...props, workingDirectory: '/project', currentSessionId: 'session-1' }));
    expect(html).toContain('aria-pressed="true">最近30天');
    expect(html).toContain('value="project" selected=""');
    for (const label of ['生成脉络图', '最近7天', '最近90天', 'AI 服务提供商', '不会修改聊天', '关闭后即丢弃']) expect(html).toContain(label);
    expect(api.generateConversationMap).not.toHaveBeenCalled();
    expect(api.getConversationMapSource).not.toHaveBeenCalled();
  });
  it('disables project scope without a bound session and explains personal-main boundaries', () => {
    const html = renderToStaticMarkup(React.createElement(ConversationMapPage, props));
    expect(html).toContain('<option value="project" disabled="">');
    expect(html).toContain('<option value="personal_main" selected="">');
    expect(html).toContain('当前没有有效项目');
    expect(html).toContain('不包含团队、派生、定时任务或渠道对话');
  });
});
