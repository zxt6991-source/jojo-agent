import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InsightGenerateInput, InsightResult } from '@desktop-agent/contracts';
import { InsightCenterPage } from './InsightCenterPage';
import { InsightEvidencePanel } from './InsightEvidencePanel';
import { InsightResultPage } from './InsightResultPage';
import { insightReducer, insightSelectionKey, defaultInsightSelection } from './state';

const request: InsightGenerateInput = { requestId: 'insight-1', range: '30d', scope: { kind: 'project', workingDirectory: '/project' }, currentSessionId: 's1', perspective: 'reverse_thinking' };
const reference = { sessionId: 's1', entryId: 'e1', seq: 1, role: 'user' as const, createdAt: '2026-10-20T10:00:00.000Z' };
const result: InsightResult = { version: 1, perspective: 'reverse_thinking', generatedAt: '2026-10-26T10:00:00.000Z',
  rangeStart: '2026-09-26T10:00:00.000Z', rangeEnd: '2026-10-26T10:00:00.000Z', scopeKind: 'project',
  analyzedTurnCount: 10, analyzedSessionCount: 2, modelCallCount: 2, semanticCacheHit: false, truncated: false, omittedTurnCount: 0,
  cards: [{ id: 'c1', title: '本地推理成本', explanation: '如果使用率低，固定成本可能更高。', nature: 'hypothesis', uncertainty: '取决于使用率',
    verificationQuestion: '实际每月调用量是多少？', supportingEventIds: ['ev1'], supportingReferences: [reference] }] };
const start = () => insightReducer({ status: 'idle' }, { type: 'start', request });
const complete = () => insightReducer(start(), { type: 'event', event: { type: 'insight.completed', requestId: request.requestId, result } });
const coverage: NonNullable<InsightResult['coverage']> = {
  extractedEventCount: 8, eligibleEventCount: 0, selectedEventCount: 0, omittedEventCount: 0, omittedCardCount: 0,
  truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1, omittedAssistantMessageCount: 0,
  unknownSourceTruncation: false, analysisPerformed: false
};

describe('insight lifecycle', () => {
  it('rejects late completion and progress after cancel, invalidation or replacement', () => {
    const event = { type: 'insight.completed' as const, requestId: request.requestId, result };
    for (const state of [insightReducer(start(), { type: 'cancel' }), insightReducer(start(), { type: 'invalidate' }),
      insightReducer(start(), { type: 'start', request: { ...request, requestId: 'insight-2' } })]) {
      expect(insightReducer(state, { type: 'event', event })).toBe(state);
      expect(insightReducer(state, { type: 'event', event: { type: 'insight.progress', requestId: request.requestId, phase: 'analyzing' } })).toBe(state);
    }
  });
  it('retains a labelled previous result on retry failure, but removes it on history invalidation', () => {
    const retry = insightReducer(complete(), { type: 'start', request: { ...request, requestId: 'retry' } });
    const failed = insightReducer(retry, { type: 'event', event: { type: 'insight.failed', requestId: 'retry', code: 'model_unavailable', message: '请配置模型' } });
    expect(failed.result?.value).toBe(result);
    expect(failed.error).toBe('请配置模型');
    expect(insightReducer(failed, { type: 'invalidate' })).toEqual({ status: 'idle' });
  });
  it.each(['second_order', 'blind_spots'] as const)('does not carry another perspective result into %s while running, failed, or cancelled', perspective => {
    const nextRequest = { ...request, requestId: 'next', perspective };
    const running = insightReducer(complete(), { type: 'start', request: nextRequest });
    expect(running.result).toBeUndefined();
    expect(insightReducer(running, { type: 'event', event: { type: 'insight.failed', requestId: 'next', code: 'request_failed', message: '失败' } }).result).toBeUndefined();
    expect(insightReducer(running, { type: 'cancel' }).result).toBeUndefined();
  });
  it('treats zero cards as a completed result and makes scope/perspective/range/project changes stale', () => {
    const empty = insightReducer(start(), { type: 'event', event: { type: 'insight.completed', requestId: request.requestId, result: { ...result, cards: [] } } });
    expect(empty.status).toBe('completed');
    expect(empty.result?.value.cards).toEqual([]);
    for (const input of [{ ...request, range: '7d' as const }, { ...request, perspective: 'blind_spots' as const },
      { ...request, currentSessionId: 'other' }, { ...request, scope: { kind: 'personal_main' as const } },
      { ...request, scope: { kind: 'project' as const, workingDirectory: '/other' } }]) expect(insightSelectionKey(input)).not.toBe(insightSelectionKey(request));
  });
});

describe('insight views', () => {
  const api = { generateInsight: vi.fn(), cancelInsight: vi.fn(), getInsightSource: vi.fn(), onInsightEvent: vi.fn(() => () => undefined),
    generateConversationMap: vi.fn(), cancelConversationMap: vi.fn(), getConversationMapSource: vi.fn(), onConversationMapEvent: vi.fn(() => () => undefined) };
  const props = { api, selection: defaultInsightSelection, onSelectionChange: vi.fn(), onOpenSource: vi.fn(), onOpenModelSettings: vi.fn() };
  it('shows the four P0 perspectives and manual-consent copy without making a model request', () => {
    const html = renderToStaticMarkup(React.createElement(InsightCenterPage, props));
    for (const label of ['AI 洞察中心', '交流脉络', '逆向思考', '二阶思考', '思维盲点', '最近7天', '最近90天', 'AI 服务提供商', '消耗模型额度']) expect(html).toContain(label);
    expect(html).toContain('aria-pressed="true">最近30天');
    expect(html).not.toContain('<option value="project"');
    expect(html).not.toContain('历史报告');
    expect(api.generateInsight).not.toHaveBeenCalled();
    expect(api.generateConversationMap).not.toHaveBeenCalled();
  });
  it('offers current project only when a directory and session are available', () => {
    const available = renderToStaticMarkup(React.createElement(InsightCenterPage, { ...props, workingDirectory: '/project', currentSessionId: 's1' }));
    const missing = renderToStaticMarkup(React.createElement(InsightCenterPage, { ...props, workingDirectory: '/project' }));
    expect(available).toContain('<option value="project">当前项目');
    expect(missing).not.toContain('<option value="project"');
  });
  it('renders four initial cards with hypothesis labels and disables evidence for stale results', () => {
    const many = { ...result, cards: Array.from({ length: 6 }, (_, index) => ({ ...result.cards[0]!, id: `c${index}`, title: `洞察 ${index}` })) };
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, { result: many, stale: true, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn() }));
    expect(html).toContain('洞察 3'); expect(html).not.toContain('洞察 4');
    expect(html).toContain('展开其余 2 条洞察');
    expect(html).toContain('AI 提出的假设'); expect(html).toContain('值得验证');
    expect(html).toContain('上一次范围的结果');
    expect(html).toContain('disabled="">用户原文');
  });
  it('distinguishes empty history from fully analyzed low-evidence output', () => {
    const props = { stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn() };
    const empty = renderToStaticMarkup(React.createElement(InsightResultPage, { ...props, result: { ...result, analyzedTurnCount: 0, cards: [] } }));
    const insufficient = renderToStaticMarkup(React.createElement(InsightResultPage, { ...props, result: { ...result, cards: [] } }));
    expect(empty).toContain('所选范围内暂无足够历史内容');
    expect(insufficient).toContain('未找到有充分证据的洞察');
    expect(insufficient).not.toContain('部分对话分析未完成');
  });
  it.each([0, 6])('explains incomplete extraction when %i turns succeeded instead of claiming insufficient evidence', analyzedTurnCount => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], analyzedTurnCount, omittedTurnCount: 15, truncated: true },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('部分对话分析未完成，暂时无法形成洞察');
    expect(html).toContain('另有 15 轮未分析');
    expect(html).toContain('重新生成会重新分析所选范围，包括本次未能分析的对话');
    expect(html).toContain('检查或切换分析模型后重试');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).toContain('<button type="button">检查模型配置</button>');
    expect(html).not.toContain('未找到有充分证据的洞察');
    expect(html).not.toContain('所选范围内暂无足够历史内容');
    expect(html).not.toContain('调整时间或数据范围');
  });
  it('explains lost sources or candidates even when all 21 turns were analyzed', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], analyzedTurnCount: 21, analyzedSessionCount: 8, omittedTurnCount: 0, truncated: true },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('已分析 21 轮 · 8 个会话');
    expect(html).toContain('分析结果不完整，暂时无法形成洞察');
    expect(html).toContain('当前结果无法判断是否有充分证据支持洞察');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).toContain('<button type="button">检查模型配置</button>');
    expect(html).not.toContain('未找到有充分证据的洞察');
    expect(html).not.toContain('当前范围内没有足够证据');
    expect(html).not.toContain('所选范围内暂无足够历史内容');
    expect(html).not.toContain('另有 0 轮未分析');
  });
  it.each([0, 15])('disables incomplete-result recovery actions while a retry is running (%i omitted turns)', omittedTurnCount => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], omittedTurnCount, truncated: true },
      stale: false, running: true, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('disabled="">正在分析…</button>');
    expect(html).toContain('disabled="">检查模型配置</button>');
  });
  it('explains the actual 21-turn coverage without treating one clipped AI reply as extraction failure', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], analyzedTurnCount: 21, analyzedSessionCount: 8, truncated: true,
        emptyReason: 'no_eligible_events', coverage },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('尚未提取到可检验的具体问题、方案、观点或约束');
    expect(html).toContain('1 条 AI 回复仅分析了部分内容');
    expect(html).toContain('用户输入已完整读取');
    expect(html).toContain('本次未调用洞察生成模型');
    expect(html).toContain('<summary>分析详情</summary>');
    expect(html).toContain('<dt>提取到的事件</dt><dd>8</dd>');
    expect(html).toContain('<dt>符合当前视角</dt><dd>0</dd>');
    expect(html).toContain('<dt>洞察生成模型</dt><dd>未调用</dd>');
    expect(html).not.toContain('本次分析不完整');
    expect(html).not.toContain('暂时无法形成洞察');
    expect(html).not.toContain('检查模型配置');
    expect(html).not.toContain('>重新生成</button>');
    expect(html).not.toContain('<details class="insight-analysis-details" open');
  });
  it('distinguishes a completed model analysis with no cards from having no eligible events', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], truncated: true, emptyReason: 'no_supported_insights', semanticCacheHit: true,
        coverage: { ...coverage, eligibleEventCount: 3, selectedEventCount: 3, analysisPerformed: true } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('未找到有充分证据的洞察');
    expect(html).toContain('<dt>洞察生成模型</dt><dd>已调用</dd>');
    expect(html).toContain('<dt>语义抽取缓存</dt><dd>已复用</dd>');
    expect(html).not.toContain('本次未调用洞察生成模型');
    expect(html).not.toContain('本次分析不完整');
    expect(html).not.toContain('检查模型配置');
  });
  it('explains the screenshot filter failure without suggesting that the unused insight model failed', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'blind_spots', cards: [], analyzedTurnCount: 21, analyzedSessionCount: 8, truncated: true,
        emptyReason: 'incomplete_analysis', coverage: { ...coverage, extractedEventCount: 51, omittedEventCount: 21, userEventCount: 0, assistantEventCount: 51 } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('21 条候选事件未通过校验或超出处理上限');
    expect(html).toContain('分析结果不完整，暂时无法形成洞察');
    expect(html).toContain('当前保留的事件均来自 AI 回复');
    expect(html).toContain('用户输入尚未提取出可用于此视角的事件');
    expect(html).toContain('<dt>用户事件</dt><dd>0</dd>');
    expect(html).toContain('<dt>AI 回复事件</dt><dd>51</dd>');
    expect(html).toContain('本次未调用洞察生成模型');
    expect(html).toContain('暂时不能判断整个范围是否存在可分析内容');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).not.toContain('检查模型配置');
    expect(html).not.toContain('检查或切换分析模型后重试');
    expect(html).not.toContain('没有找到适合此视角的用户观点');
    expect(html).not.toContain('至少两条不同用户消息');
  });
  it('explains missing extracted blind-spot events without requiring multiple user messages', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'blind_spots', cards: [], analyzedTurnCount: 1, truncated: false,
        emptyReason: 'no_eligible_events', coverage: { ...coverage, extractedEventCount: 3, truncatedAssistantMessageCount: 0 } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('尚未提取到可分析的具体问题、观点、约束或方案');
    expect(html).toContain('尚未从用户输入中提取到可分析的具体问题、观点、约束或方案');
    expect(html).toContain('可以选择包含具体问题、观点、约束或方案的时间或项目范围');
    expect(html).toContain('本次未调用洞察生成模型');
    expect(html).not.toContain('本次分析不完整');
    expect(html).not.toContain('>重新生成</button>');
    expect(html).not.toContain('检查模型配置');
    expect(html).not.toContain('至少两条不同用户消息');
    expect(html).not.toContain('<dt>用户事件</dt>');
    expect(html).not.toContain('<dt>AI 回复事件</dt>');
  });
  it.each([
    { perspective: 'second_order' as const, evidence: '可推演影响的明确方案或探讨备选方案的问题', scope: '明确方案、计划、决定、改选，或探讨备选方案的问题' },
    { perspective: 'reverse_thinking' as const, evidence: '可检验的具体问题、方案、观点或约束', scope: '具体问题、方案、观点、约束或决定' }
  ])('explains why $perspective skipped synthesis for the screenshot coverage', ({ perspective, evidence, scope }) => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective, cards: [], analyzedTurnCount: 21, analyzedSessionCount: 8, truncated: true,
        emptyReason: 'incomplete_analysis', coverage: { ...coverage, extractedEventCount: 51, userEventCount: 13,
          assistantEventCount: 38, omittedEventCount: 11 } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('已分析 21 轮 · 8 个会话');
    expect(html).toContain('分析结果不完整，暂时无法形成洞察');
    expect(html).toContain('11 条候选事件未通过校验或超出处理上限');
    expect(html).toContain(`当前保留的 13 条用户事件中，尚未找到${evidence}`);
    expect(html).toContain('本次未调用洞察生成模型');
    expect(html).toContain('暂时不能判断整个范围是否存在可分析内容');
    expect(html).toContain(`可以选择包含${scope}的范围`);
    expect(html).toContain('<dt>用户事件</dt><dd>13</dd>');
    expect(html).toContain('<dt>AI 回复事件</dt><dd>38</dd>');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).not.toContain('检查模型配置');
    expect(html).not.toContain('检查或切换分析模型后重试');
    expect(html).not.toContain('当前保留的事件均来自 AI 回复');
    expect(html).not.toContain('未找到有充分证据的洞察');
  });
  it('explains a complete second-order extraction with no options without suggesting a failed model', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'second_order', cards: [], emptyReason: 'no_eligible_events',
        coverage: { ...coverage, userEventCount: 3, assistantEventCount: 5 } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('<h2>尚未提取到可推演影响的明确方案或探讨备选方案的问题</h2>');
    expect(html).toContain('当前保留的 3 条用户事件中，尚未找到可推演影响的明确方案或探讨备选方案的问题');
    expect(html).toContain('可以选择包含明确方案、计划、决定、改选，或探讨备选方案的问题的时间或项目范围');
    expect(html).toContain('本次未调用洞察生成模型');
    expect(html).not.toContain('本次分析不完整');
    expect(html).not.toContain('检查模型配置');
    expect(html).not.toContain('>重新生成</button>');
  });
  it('disables the extraction retry when an ineligible second-order result is regenerating', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'second_order', cards: [], emptyReason: 'incomplete_analysis',
        coverage: { ...coverage, omittedEventCount: 11 } },
      stale: false, running: true, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('disabled="">正在分析…</button>');
    expect(html).not.toContain('检查模型配置');
  });
  it('distinguishes a synthesized empty blind-spot answer from skipped analysis of a single question', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'blind_spots', cards: [], analyzedTurnCount: 1, truncated: false, emptyReason: 'no_supported_insights',
        coverage: { ...coverage, extractedEventCount: 1, userEventCount: 1, assistantEventCount: 0, eligibleEventCount: 1,
          selectedEventCount: 1, truncatedAssistantMessageCount: 0, analysisPerformed: true } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('未找到有充分证据的洞察');
    expect(html).toContain('<dt>洞察生成模型</dt><dd>已调用</dd>');
    expect(html).toContain('<dt>用户事件</dt><dd>1</dd>');
    expect(html).not.toContain('本次未调用洞察生成模型');
    expect(html).not.toContain('尚未提取到可分析');
    expect(html).not.toContain('至少两条不同用户消息');
  });
  it('keeps failed topic grouping incomplete and offers a retry when no blind-spot themes qualified', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, perspective: 'blind_spots', cards: [], truncated: true, emptyReason: 'incomplete_analysis',
        coverage: { ...coverage, topicGroupingIncomplete: true } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('相关讨论的主题归并未完成');
    expect(html).toContain('暂时不能判断整个范围是否存在可分析内容');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).not.toContain('<h2>尚未提取到可分析的具体问题、观点、约束或方案</h2>');
    expect(html).not.toContain('检查模型配置');
  });
  it('does not claim retry can restore user text clipped by a fixed source limit', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], truncated: true, emptyReason: 'incomplete_analysis',
        coverage: { ...coverage, truncatedUserMessageCount: 1 } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('分析结果不完整，暂时无法形成洞察');
    expect(html).toContain('1 条用户输入仅分析了部分内容');
    expect(html).toContain('相同范围重复生成不会改变读取上限');
    expect(html).not.toContain('用户输入已完整读取');
    expect(html).not.toContain('>重新生成</button>');
    expect(html).not.toContain('检查模型配置');
  });
  it('still offers model settings when eligible events were analyzed but other candidates were discarded', () => {
    const html = renderToStaticMarkup(React.createElement(InsightResultPage, {
      result: { ...result, cards: [], truncated: true, emptyReason: 'incomplete_analysis',
        coverage: { ...coverage, omittedEventCount: 2, eligibleEventCount: 2, selectedEventCount: 2, analysisPerformed: true } },
      stale: false, running: false, onReadSource: vi.fn(), onRegenerate: vi.fn(), onOpenModelSettings: vi.fn()
    }));
    expect(html).toContain('2 条候选事件未通过校验或超出处理上限');
    expect(html).toContain('<button type="button">重新生成</button>');
    expect(html).toContain('<button type="button">检查模型配置</button>');
    expect(html).not.toContain('没有找到适合此视角的用户观点');
  });
  it('escapes raw source content and never offers a jump for unavailable evidence', () => {
    const sourceInput = { requestId: request.requestId, sessionId: 's1', entryId: 'e1' };
    const html = renderToStaticMarkup(React.createElement(InsightEvidencePanel, { source: { input: sourceInput, status: 'ready', value: { available: true, reference, messageId: 'm1', text: '<script>run()</script>', truncated: false } }, jumping: false, onJump: vi.fn(), onClose: vi.fn() }));
    expect(html).toContain('&lt;script&gt;run()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    const unavailable = renderToStaticMarkup(React.createElement(InsightEvidencePanel, { source: { input: sourceInput, status: 'ready', value: { available: false } }, jumping: false, onJump: vi.fn(), onClose: vi.fn() }));
    expect(unavailable).toContain('引用不可用'); expect(unavailable).not.toContain('查看原始对话');
  });
});
