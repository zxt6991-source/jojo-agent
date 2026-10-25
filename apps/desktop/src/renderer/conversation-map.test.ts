import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationMapGenerateInput, ConversationMapResult, ConversationMapResultV2, ConversationTopic, ConversationTopicV2 } from '@desktop-agent/contracts';
import { ConversationMapPage, ConversationTopicInsights } from './ConversationMapPage';
import { conversationFlowchart, evolutionFlowchart, insightEvidence, orderedEvents, conversationMapReducer, conversationMapSelectionKey, conversationMindmap, mermaidLabel, orderedSteps, conversationPlainText, compactConversationText, eventReadingText, eventReadingTitle, type ConversationMapViewState } from './conversation-map';

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
    expect(diagram).toContain('n0["如何安排设置界面？"]:::question');
    expect(diagram).toContain('n1["建议两栏布局"]:::answer');
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
    for (const phase of ['reading', 'extracting', 'merging', 'comparing', 'rendering'] as const) {
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


const evolutionTopic: ConversationTopicV2 = {
  id: 'topic-1', title: '生成方式', summary: '交流脉络的触发方式',
  events: [
    { id: 'early', topicId: 'topic-1', subjectKey: 'map', dimensionKey: 'trigger', eventType: 'position', speaker: 'user', state: 'considering', claim: '考虑自动生成', occurredAt: reference.createdAt, evidence: [{ reference, quote: '考虑自动生成' }], truncatedSource: false },
    { id: 'detail', topicId: 'topic-1', subjectKey: 'map', dimensionKey: 'trigger', eventType: 'option', speaker: 'assistant', state: 'considering', claim: '建议设置页入口', occurredAt: '2026-10-21T10:00:00.000Z', evidence: [{ reference: { ...reference, role: 'assistant', entryId: 'detail', createdAt: '2026-10-21T10:00:00.000Z' }, quote: '建议设置页入口' }], truncatedSource: false },
    { id: 'latest', topicId: 'topic-1', subjectKey: 'map', dimensionKey: 'trigger', eventType: 'decision', speaker: 'user', state: 'decided', claim: '改为手动生成', occurredAt: '2026-10-22T10:00:00.000Z', evidence: [{ reference: { ...reference, sessionId: 'session-2', entryId: 'latest', createdAt: '2026-10-22T10:00:00.000Z' }, quote: '改为手动生成' }], truncatedSource: false }
  ],
  changes: [{ id: 'change', topicId: 'topic-1', fromEventId: 'early', toEventId: 'latest', relation: 'revised', explanation: '从自动生成改为手动生成' }],
  insights: [
    { id: 'insight', kind: 'key_change', text: '从自动生成改为手动生成', supportingEventIds: [], supportingChangeIds: ['change'] },
    { id: 'current', kind: 'current_state', text: '用户已决定手动生成，聊天中未确认执行', supportingEventIds: ['latest'], supportingChangeIds: [] }
  ], visibleEventIds: ['latest', 'early']
};
const evolutionResult: ConversationMapResultV2 = { ...result, version: 2, topics: [evolutionTopic], modelCallCount: 2, omittedEventCount: 0 };

describe('V2 evidence-backed timelines', () => {
  it('removes display markup while preserving conditions, negation, numbers and code identifiers', () => {
    const original = '### 买入方式\n- **如果持有 2 年以上**，才考虑 A 类；\n- 尚未买入，`route_id` 不变。见[原始分析](https://example.com)。';
    expect(conversationPlainText(original)).toBe('买入方式 如果持有 2 年以上，才考虑 A 类； 尚未买入，route_id 不变。见原始分析。');
    expect(compactConversationText('🙂'.repeat(80), 20)).toBe(`${'🙂'.repeat(19)}…`);
    expect(compactConversationText('尚未买入', 20)).toBe('尚未买入');
  });
  it('uses short multiline reading labels and keeps full claims and exact evidence untouched', () => {
    const claim = '- **A 类 vs C 类**：如果持有 2 年以上，才考虑 A 类；未确定持有期则考虑 C 类。'.repeat(3);
    const event = { ...evolutionTopic.events[1]!, subjectLabel: '基金份额', dimensionLabel: '持有期', claim,
      summary: '如果持有 2 年以上，考虑 A 类；持有期不确定则考虑 C 类。', evidence: [{ ...evolutionTopic.events[1]!.evidence[0]!, quote: claim }] };
    const diagram = evolutionFlowchart({ ...evolutionTopic, events: [event], visibleEventIds: [event.id], changes: [] });
    expect(eventReadingTitle(event)).toBe('基金份额');
    expect(eventReadingText(event)).toBe(event.summary);
    expect(diagram).toContain('n0["基金份额<br/>如果持有 2 年以上');
    for (const metadata of ['AI ·', 'AI 摘要', '考虑中', '2026/', '持有期<br/>']) expect(diagram).not.toContain(metadata);
    expect(diagram).toContain('如果持有 2 年以上');
    expect(diagram).not.toContain('**');
    expect(diagram).not.toContain('vs C');
    const fallback = evolutionFlowchart({ ...evolutionTopic, events: [{ ...event, summary: undefined }], visibleEventIds: [event.id], changes: [] });
    expect(fallback).not.toContain('原文摘录');
    expect(fallback).toContain('…');
    expect(event.evidence[0]!.quote).toBe(claim);
    expect(event.claim).toBe(claim);
  });
  it('defaults to selected stages in source order and separates chronology from verified changes', () => {
    expect(orderedEvents(evolutionTopic).map(event => event.id)).toEqual(['early', 'latest']);
    expect(orderedEvents(evolutionTopic, true).map(event => event.id)).toEqual(['early', 'detail', 'latest']);
    const diagram = evolutionFlowchart(evolutionTopic);
    expect(diagram).toContain('考虑自动生成');
    expect(diagram).toContain('改为手动生成');
    expect(diagram).not.toContain('用户 · 观点');
    expect(diagram).not.toContain('已决定');
    expect(diagram).toContain('n0 -->|修订| n1');
    expect(diagram).not.toContain('建议设置页入口');
    const noChanges = evolutionFlowchart({ ...evolutionTopic, changes: [] });
    expect(noChanges).toContain('n0 -.-> n1');
    expect(noChanges).not.toContain('时间先后');
    expect(noChanges).not.toContain('修订|');
  });
  it('avoids repeating object labels and keeps the ending of a full summary', () => {
    const event = { ...evolutionTopic.events[0]!, subjectLabel: 'MCP 工具', dimensionLabel: '会话内可用性',
      summary: `MCP 工具在会话建立时注入。${'当前会话不会加载新增工具。'.repeat(4)}需要新开会话。` };
    expect(eventReadingTitle(event)).toBe('');
    expect(eventReadingTitle({ ...event, subjectLabel: undefined })).toBe('');
    const diagram = evolutionFlowchart({ ...evolutionTopic, events: [event], visibleEventIds: [event.id], changes: [] });
    expect(diagram.replaceAll('<br/>', '')).toContain(event.summary);
    expect(diagram).not.toContain('会话内可用性');
  });
  it('shows evidence from both endpoints and explicit reason evidence when selecting an insight', () => {
    const evidence = insightEvidence(evolutionTopic, evolutionTopic.insights[0]!);
    expect(evidence.map(item => item.quote)).toEqual(['考虑自动生成', '改为手动生成']);
    const reason = { reference: { ...reference, entryId: 'reason' }, quote: '为了降低费用' };
    expect(insightEvidence({ ...evolutionTopic, changes: [{ ...evolutionTopic.changes[0]!, reasonEvidence: [reason] }] }, evolutionTopic.insights[0]!)).toContainEqual(reason);
  });
  it('uses escaped labels and synthetic IDs for V2 diagrams and limits overview summaries', () => {
    const poison = '"]\nclick n0 "javascript:alert(1)"<img src=x>%%{init:evil}%%';
    const diagram = evolutionFlowchart({ ...evolutionTopic, events: evolutionTopic.events.map(event => ({ ...event, claim: poison })) });
    expect(diagram).not.toContain('<img');
    expect(diagram).not.toMatch(/^\s*click /mu);
    expect(diagram).not.toContain('%%');
    const overview = conversationMindmap(evolutionResult);
    expect(overview).toContain('从自动生成改为手动生成');
    expect(overview).not.toContain('建议设置页入口');
    expect(overview.split('\n').length).toBeLessThanOrEqual(6);
  });
  it('renders useful insight categories without inventing a change when evidence is absent', () => {
    const html = renderToStaticMarkup(React.createElement(ConversationTopicInsights, { topic: evolutionTopic, onSelect: vi.fn() }));
    for (const label of ['关键变化', '当前结论', '待解决', '聊天中未确认执行', '查看变化证据']) expect(html).toContain(label);
    const sparse = renderToStaticMarkup(React.createElement(ConversationTopicInsights, { topic: { ...evolutionTopic, changes: [], insights: [] }, onSelect: vi.fn() }));
    expect(sparse).toContain('尚未发现具有明确原文依据的观点变化');
    expect(sparse).not.toContain('从自动生成改为手动生成');
  });
  it('clears derived conclusions and ignores pending completion when sources are invalidated', () => {
    const completed = conversationMapReducer(start(), { type: 'event', event: { type: 'conversation-map.completed', requestId: request.requestId, result: evolutionResult } });
    const invalidated = conversationMapReducer(start(completed), { type: 'invalidate' });
    expect(invalidated.result).toBeUndefined();
    expect(complete(invalidated)).toBe(invalidated);
  });
});
