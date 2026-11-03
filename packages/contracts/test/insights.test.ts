import { describe, expect, it } from 'vitest';
import {
  InsightGenerateInputSchema, InsightCardSchema, InsightResultSchema, InsightCoverageSchema,
  WorkerCommandSchema, WorkerMessageSchema
} from '../src/index.js';

const reference = { sessionId: 's', entryId: 'e', seq: 1, createdAt: '2026-10-20T00:00:00.000Z', role: 'user' as const };
const card = {
  id: 'card', title: '验证成本假设', explanation: '如果维护成本上升，可能改变方案取舍。',
  nature: 'hypothesis' as const, uncertainty: '尚未确认维护成本。', verificationQuestion: '可以先测量一周吗？',
  supportingEventIds: ['event'], supportingReferences: [reference]
};
const result = {
  version: 1, perspective: 'reverse_thinking', generatedAt: '2026-10-26T00:00:00.000Z',
  rangeStart: '2026-10-01T00:00:00.000Z', rangeEnd: '2026-10-26T00:00:00.000Z', scopeKind: 'personal_main',
  analyzedTurnCount: 1, analyzedSessionCount: 1, truncated: false, omittedTurnCount: 0,
  modelCallCount: 2, semanticCacheHit: false, cards: [card]
};
const input = { requestId: 'i1', perspective: 'reverse_thinking', range: '30d', scope: { kind: 'personal_main' } };
const coverage = { extractedEventCount: 2, eligibleEventCount: 0, selectedEventCount: 0, omittedEventCount: 0, omittedCardCount: 0,
  truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1, omittedAssistantMessageCount: 0, unknownSourceTruncation: false, analysisPerformed: false };

describe('insight contracts', () => {
  it('carries bounded progress detail and topic grouping through the worker protocol', () => {
    for (const type of ['insight', 'conversation-map']) {
      const event = { type: `${type}.progress`, requestId: 'i1', phase: 'merging', detail: '正在归并 3 个主题。' };
      const envelope = { type: `${type}.event`, event };
      expect(WorkerMessageSchema.parse(envelope)).toEqual(envelope);
      for (const detail of ['', ' '.repeat(4), 'x'.repeat(501)]) {
        expect(WorkerMessageSchema.safeParse({ ...envelope, event: { ...event, detail } }).success).toBe(false);
      }
    }
  });

  it('only allows the published perspectives and bounded, authorized scope requests', () => {
    expect(InsightGenerateInputSchema.parse(input)).toEqual(input);
    for (const perspective of ['conversation_map', 'value_clarification', 'custom']) {
      expect(InsightGenerateInputSchema.safeParse({ ...input, perspective }).success).toBe(false);
    }
    expect(InsightGenerateInputSchema.safeParse({ ...input, allowedSessionIds: ['hidden'] }).success).toBe(false);
    expect(InsightGenerateInputSchema.safeParse({ ...input, range: '365d' }).success).toBe(false);
  });

  it('requires evidence and rejects duplicate references, IDs and oversized claims', () => {
    expect(InsightCardSchema.parse(card)).toEqual(card);
    expect(InsightCardSchema.safeParse({ ...card, supportingReferences: [] }).success).toBe(false);
    expect(InsightCardSchema.safeParse({ ...card, supportingReferences: [reference, reference] }).success).toBe(false);
    expect(InsightCardSchema.safeParse({ ...card, supportingEventIds: ['event', 'event'] }).success).toBe(false);
    expect(InsightCardSchema.safeParse({ ...card, explanation: 'x'.repeat(1201) }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...result, cards: [card, card] }).success).toBe(false);
  });

  it('permits zero cards but rejects evidence outside the selected range', () => {
    expect(InsightResultSchema.safeParse(result).success).toBe(true);
    expect(InsightResultSchema.safeParse({ ...result, cards: [] }).success).toBe(true);
    expect(InsightResultSchema.safeParse({ ...result, rangeStart: result.rangeEnd }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...result, rangeEnd: reference.createdAt }).success).toBe(false);
  });

  it('validates all worker insight command and message variants', () => {
    for (const command of [
      { type: 'insight.generate', input },
      { type: 'insight.cancel', requestId: 'i1' },
      { type: 'insight.source', requestId: 'rpc', input: { requestId: 'i1', sessionId: 's', entryId: 'e' } }
    ]) expect(WorkerCommandSchema.safeParse(command).success).toBe(true);
    for (const event of [
      { type: 'insight.progress', requestId: 'i1', phase: 'extracting', completed: 1, total: 2 },
      { type: 'insight.completed', requestId: 'i1', result },
      { type: 'insight.failed', requestId: 'i1', code: 'history_changed', message: '历史已更改' },
      { type: 'insight.cancelled', requestId: 'i1' }
    ]) expect(WorkerMessageSchema.safeParse({ type: 'insight.event', event }).success).toBe(true);
    expect(WorkerMessageSchema.safeParse({ type: 'insight.source.result', requestId: 'rpc', result: { available: false } }).success).toBe(true);
    expect(WorkerCommandSchema.safeParse({ type: 'insight.generate', input: { ...input, apiKey: 'secret' } }).success).toBe(false);
  });

  it('distinguishes assistant source limits from missing eligible user evidence through IPC', () => {
    const withCoverage = { ...result, cards: [], truncated: true, emptyReason: 'no_eligible_events', coverage };
    expect(WorkerMessageSchema.safeParse({ type: 'insight.event', event: { type: 'insight.completed', requestId: 'i1', result: withCoverage } }).success).toBe(true);
    expect(InsightResultSchema.safeParse({ ...withCoverage, cards: [card] }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...withCoverage, emptyReason: 'no_history' }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...withCoverage, emptyReason: 'no_supported_insights' }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...withCoverage, emptyReason: 'incomplete_analysis' }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...withCoverage, coverage: { ...coverage, truncatedUserMessageCount: 1 } }).success).toBe(false);
  });

  it('keeps unsuccessful topic grouping incomplete through IPC even when every turn was read', () => {
    const incomplete = { ...result, perspective: 'blind_spots', cards: [], truncated: true,
      emptyReason: 'incomplete_analysis', coverage: { ...coverage, topicGroupingIncomplete: true } };
    expect(WorkerMessageSchema.safeParse({ type: 'insight.event', event: { type: 'insight.completed', requestId: 'i1', result: incomplete } }).success).toBe(true);
    expect(InsightResultSchema.safeParse({ ...incomplete, emptyReason: 'no_eligible_events' }).success).toBe(false);
    expect(InsightResultSchema.safeParse({ ...incomplete, coverage: { ...coverage, topicGroupingIncomplete: false } }).success).toBe(false);
  });

  it('reports retained source roles without treating assistant events as user evidence', () => {
    expect(InsightCoverageSchema.safeParse({ ...coverage, userEventCount: 0, assistantEventCount: 2 }).success).toBe(true);
    expect(InsightCoverageSchema.safeParse({ ...coverage, userEventCount: 0, assistantEventCount: 1 }).success).toBe(false);
    expect(InsightCoverageSchema.safeParse({ ...coverage, eligibleEventCount: 1, userEventCount: 0, assistantEventCount: 2 }).success).toBe(false);
  });

  it.each([
    { eligibleEventCount: 3 }, { selectedEventCount: 1 }, { analysisPerformed: true }, { omittedEventCount: -1 },
    { truncatedUserMessageCount: 0.5 }, { rawPrompt: 'private text' }
  ])('rejects invalid or unsafe coverage: %j', change => {
    expect(InsightCoverageSchema.safeParse({ ...coverage, ...change }).success).toBe(false);
  });
});
