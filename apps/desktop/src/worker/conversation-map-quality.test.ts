import { describe, expect, it, vi } from 'vitest';
import type { ConversationMapHistoryQuery, ConversationTurnRecord, MessageReference } from '@desktop-agent/contracts';
import { qualityScenarios, type AnnotatedMessage, type QualityScenario } from '../../../../evals/conversation-map-quality/scenarios';
import { generateConversationMap, type ConversationMapDependencies } from './conversation-map-service';

const request = { range: '30d' as const, scope: { kind: 'personal_main' as const } };
const now = new Date('2026-10-24T12:00:00.000Z');
const marker = '\nUNTRUSTED_CONVERSATION_DATA_JSON\n';
type Candidate = {
  topicLabel: string; subjectLabel: string; dimensionLabel: string;
  eventType: NonNullable<AnnotatedMessage['eventType']>; speaker: 'user' | 'assistant';
  state: NonNullable<AnnotatedMessage['state']>; claim: string;
  evidence: { evidenceId: string; exactQuote: string }[];
};
type ProposedChange = { fromEventId: string; toEventId: string; relation: string };
type HarnessOptions = {
  alterExtraction?: (events: Candidate[]) => void;
  changes?: ProposedChange[];
  comparisonResponse?: string;
};

function scenario(id: string): QualityScenario { return structuredClone(qualityScenarios.find(item => item.id === id)!); }
function fixture(suite: QualityScenario, options: HarnessOptions = {}) {
  const annotations = new Map<string, AnnotatedMessage>();
  const entryIds = new Map<string, string>();
  const eventIds = new Map<string, string>();
  let eventCounter = 0;
  const turns: ConversationTurnRecord[] = suite.turns.map((turn, index) => {
    const timestamp = new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
    const message = (value: AnnotatedMessage, role: 'user' | 'assistant') => {
      const entryId = `${suite.id}-${index}-${role}`;
      annotations.set(entryId, value);
      if (value.key) entryIds.set(value.key, entryId);
      if (value.eventType && value.key) eventIds.set(value.key, `v${++eventCounter}`);
      return {
        text: value.text, truncated: value.truncated ?? false,
        reference: { sessionId: turn.session, entryId, seq: index * 2 + (role === 'assistant' ? 1 : 0), role,
          createdAt: new Date(Date.parse(timestamp) + (role === 'assistant' ? 1000 : 0)).toISOString() }
      };
    };
    return { sessionId: turn.session, turnId: `${suite.id}-${index}`, createdAt: timestamp,
      truncated: false, user: message(turn.user, 'user'), assistants: turn.assistant ? [message(turn.assistant, 'assistant')] : [] };
  });
  const complete = vi.fn(async (prompt: string): Promise<string> => {
    const data = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
    if (prompt.includes('TASK: EXTRACT.')) {
      const events: Candidate[] = data.flatMap((turn: { messages: { id: string; reference: MessageReference }[] }) => turn.messages.flatMap(message => {
        const annotated = annotations.get(message.reference.entryId)!;
        if (!annotated.eventType) return [];
        return [{ topicLabel: annotated.topic ?? suite.topic, subjectLabel: annotated.subject ?? suite.subject,
          dimensionLabel: annotated.dimension ?? suite.dimension, eventType: annotated.eventType,
          speaker: message.reference.role, state: annotated.state ?? 'unknown', claim: annotated.text,
          evidence: [{ evidenceId: message.id, exactQuote: annotated.text }] }];
      }));
      options.alterExtraction?.(events);
      return JSON.stringify({ events });
    }
    if (prompt.includes('TASK: MERGE.')) return JSON.stringify({ groups: [{ memberIds: data.map((topic: { id: string }) => topic.id) }] });
    if (prompt.includes('TASK: COMPARE.')) return options.comparisonResponse ?? JSON.stringify({ changes: options.changes ?? suite.changes.map(change => ({
      fromEventId: eventIds.get(change.from), toEventId: eventIds.get(change.to), relation: change.relation
    })) });
    throw new Error('Unexpected model stage');
  });
  const deps: ConversationMapDependencies = {
    readPage: vi.fn((query: ConversationMapHistoryQuery) => {
      const offset = query.cursor ? turns.findIndex(turn => turn.user.reference.seq === query.cursor!.seq) + 1 : 0;
      const items = turns.slice(offset, offset + query.limit);
      const hasMore = offset + items.length < turns.length;
      const last = items.at(-1);
      return { turns: items, hasMore, ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, sessionId: last.sessionId, seq: last.user.reference.seq } } : {}) };
    }), complete, revalidateReferences: vi.fn((refs: MessageReference[]) => refs), signal: new AbortController().signal, now: () => now
  };
  return { deps, complete, turns, entryIds, eventIds };
}

describe('conversation-map quality: fictional annotated multi-session baseline', () => {
  it.each(qualityScenarios)('$id $name', async suite => {
    const harness = fixture(suite);
    const result = await generateConversationMap(request, harness.deps);
    expect(result.version).toBe(2);
    expect(result.analyzedSessionCount).toBe(new Set(suite.turns.map(turn => turn.session)).size);
    const events = result.topics.flatMap(topic => topic.events);
    const changes = result.topics.flatMap(topic => topic.changes);
    const visible = new Set(result.topics.flatMap(topic => topic.visibleEventIds));
    for (const key of suite.mustShow) {
      const event = events.find(event => event.evidence.some(evidence => evidence.reference.entryId === harness.entryIds.get(key)));
      expect(event, `${suite.id}: missing key event ${key}`).toBeDefined();
      expect(visible.has(event!.id), `${suite.id}: key event not shown ${key}`).toBe(true);
    }
    for (const event of events) {
      const evidence = event.evidence[0]!;
      const original = harness.turns.flatMap(turn => [turn.user, ...turn.assistants]).find(message => message.reference.entryId === evidence.reference.entryId)!;
      expect(evidence.reference).toEqual(original.reference);
      expect(original.text).toContain(evidence.quote);
      expect(event.speaker).toBe(original.reference.role);
      expect(event.occurredAt).toBe(original.reference.createdAt);
      const annotation = suite.turns.flatMap(turn => [turn.user, ...(turn.assistant ? [turn.assistant] : [])]).find(message => message.text === original.text)!;
      expect(event.state).toBe(annotation.state);
      expect(event.eventType).toBe(annotation.expectedEventType ?? annotation.eventType);
    }
    expect(changes).toHaveLength(suite.changes.length);
    for (const expected of suite.changes) {
      const from = events.find(event => event.evidence.some(evidence => evidence.reference.entryId === harness.entryIds.get(expected.from)))!;
      const to = events.find(event => event.evidence.some(evidence => evidence.reference.entryId === harness.entryIds.get(expected.to)))!;
      expect(from.evidence[0]!.reference.sessionId).not.toBe(to.evidence[0]!.reference.sessionId);
      expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ fromEventId: from.id, toEventId: to.id, relation: expected.relation })]));
    }
    if (!suite.causeSupported) for (const change of changes) {
      expect(change.reasonEvidence ?? []).toEqual([]);
      expect(change.explanation).not.toMatch(/因为|所以|导致|由于/);
    }
    for (const topic of result.topics) {
      expect(topic.visibleEventIds.length).toBeLessThanOrEqual(8);
      expect(topic.events.length).toBeLessThanOrEqual(20);
      for (const insight of topic.insights) {
        expect(insight.supportingEventIds.length).toBeGreaterThan(0);
        expect(insight.supportingEventIds.every(id => topic.events.some(event => event.id === id))).toBe(true);
        expect(insight.supportingChangeIds.every(id => topic.changes.some(change => change.id === id))).toBe(true);
      }
    }
    if (suite.id === 'Q09') expect(result.omittedEventCount).toBeGreaterThan(0);
    if (suite.id === 'Q12') expect(result.truncated).toBe(true);
    if (suite.id === 'Q15') expect(result.topics).toHaveLength(1);
  });
});

describe('conversation-map quality: adversarial candidate verification', () => {
  it.each([
    ['Q03', 'assistant', 'decision', 'decided'],
    ['Q03', 'assistant', 'action', 'reported_done'],
    ['Q04', 'user', 'action', 'reported_done'],
    ['Q07', 'user', 'action', 'reported_done']
  ] as const)('%s cannot promote %s evidence to %s/%s', async (id, speaker, eventType, state) => {
    const suite = scenario(id);
    const harness = fixture(suite, { alterExtraction(events) {
      const candidate = events.find(event => event.speaker === speaker)!;
      candidate.eventType = eventType;
      candidate.state = state;
    } });
    const result = await generateConversationMap(request, harness.deps);
    const events = result.topics.flatMap(topic => topic.events);
    const invalidQuote = speaker === 'assistant' ? suite.turns[0]!.assistant!.text : suite.turns[0]!.user.text;
    expect(events.some(event => event.evidence.some(item => item.quote === invalidQuote))).toBe(false);
  });

  it('Q07 checks hypothetical context outside a cherry-picked exact quote', async () => {
    const harness = fixture(scenario('Q07'), { alterExtraction(events) {
      events[0]!.eventType = 'action'; events[0]!.state = 'reported_done';
      events[0]!.evidence[0]!.exactQuote = '我已经减仓一半';
      events[0]!.claim = '用户已经减仓一半';
    } });
    const result = await generateConversationMap(request, harness.deps);
    expect(result.topics.flatMap(topic => topic.events).some(event => event.state === 'reported_done')).toBe(false);
  });

  it('Q06 never accepts an unsupported claim even when its quote is valid', async () => {
    const harness = fixture(scenario('Q06'), { alterExtraction(events) { events[0]!.claim = '因为经济困难所以已卖出全部资产'; } });
    const result = await generateConversationMap(request, harness.deps);
    expect(JSON.stringify(result)).not.toContain('经济困难');
    expect(JSON.stringify(result)).not.toContain('已卖出全部资产');
  });

  it.each(['object', 'dimension', 'time', 'missing', 'uncertain', 'unrelated-revision'] as const)('discards unsupported %s comparisons', async fault => {
    const suite = scenario('Q05');
    let proposed: ProposedChange = { fromEventId: 'v1', toEventId: 'v2', relation: 'revised' };
    if (fault === 'object') suite.turns[1]!.user.subject = '另一个模块';
    if (fault === 'dimension') suite.turns[1]!.user.dimension = '视觉样式';
    if (fault === 'time') proposed = { ...proposed, fromEventId: 'v2', toEventId: 'v1' };
    if (fault === 'missing') proposed = { ...proposed, fromEventId: 'v999' };
    if (fault === 'uncertain') proposed = { ...proposed, relation: 'uncertain' };
    if (fault === 'unrelated-revision') {
      suite.turns[1]!.user.text = '我也考虑给界面增加帮助说明。';
      suite.turns[1]!.user.eventType = 'option'; suite.turns[1]!.user.state = 'considering';
    }
    const harness = fixture(suite, { changes: [proposed] });
    const result = await generateConversationMap(request, harness.deps);
    expect(result.topics.flatMap(topic => topic.changes)).toEqual([]);
    expect(result.topics.flatMap(topic => topic.insights).filter(insight => insight.kind === 'key_change')).toEqual([]);
  });

  it('Q12 removes changes touching a truncated source even if proposed', async () => {
    const harness = fixture(scenario('Q12'), { changes: [{ fromEventId: 'v1', toEventId: 'v2', relation: 'revised' }] });
    const result = await generateConversationMap(request, harness.deps);
    expect(result.truncated).toBe(true);
    expect(result.topics.flatMap(topic => topic.changes)).toEqual([]);
    expect(result.topics.flatMap(topic => topic.events).some(event => event.truncatedSource)).toBe(true);
  });

  it('Q06 rejects fabricated causal explanation fields and degrades to facts', async () => {
    const harness = fixture(scenario('Q06'), { comparisonResponse: JSON.stringify({ changes: [
      { fromEventId: 'v1', toEventId: 'v2', relation: 'revised', explanation: '因为经济困难，所以改变阅读计划。' }
    ] }) });
    const result = await generateConversationMap(request, harness.deps);
    expect(result.topics.flatMap(topic => topic.events)).toHaveLength(2);
    expect(result.topics.flatMap(topic => topic.changes)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('经济困难');
  });

  it('keeps a factual timeline when comparison provider fails', async () => {
    const harness = fixture(scenario('Q01'));
    harness.deps.complete = vi.fn(async prompt => {
      if (prompt.includes('TASK: COMPARE.')) throw new Error('private provider diagnostics');
      return harness.complete(prompt);
    });
    const result = await generateConversationMap(request, harness.deps);
    expect(result.topics.flatMap(topic => topic.events)).toHaveLength(3);
    expect(result.topics.flatMap(topic => topic.changes)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private provider diagnostics');
  });

  it('Q10 removes all derived content from a source revoked during analysis', async () => {
    const harness = fixture(scenario('Q10'));
    harness.deps.revalidateReferences = vi.fn((refs: MessageReference[]) => refs.filter(ref => ref.sessionId !== 'deleted-a'));
    const result = await generateConversationMap(request, harness.deps);
    expect(result.topics).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('Q13 aborts comparison promptly and ignores late model success', async () => {
    const harness = fixture(scenario('Q05'));
    const controller = new AbortController();
    harness.deps.signal = controller.signal;
    let resolve!: (value: string) => void;
    let comparing = false;
    harness.deps.complete = vi.fn(async prompt => {
      if (!prompt.includes('TASK: COMPARE.')) return harness.complete(prompt);
      comparing = true;
      return new Promise<string>(res => { resolve = res; });
    });
    const operation = generateConversationMap(request, harness.deps);
    await vi.waitFor(() => expect(comparing).toBe(true));
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    resolve(JSON.stringify({ changes: [{ fromEventId: 'v1', toEventId: 'v2', relation: 'revised' }] }));
    await Promise.resolve();
    expect(harness.deps.revalidateReferences).not.toHaveBeenCalled();
  });

  it.each(['id', 'quote', 'role', 'time', 'final-id'] as const)('Q14 omits forged %s after a bounded retry without discarding verified events', async fault => {
    const harness = fixture(scenario('Q14'), { alterExtraction(events) {
      if (fault === 'id') events[0]!.evidence[0]!.evidenceId = 'invented';
      if (fault === 'quote') events[0]!.evidence[0]!.exactQuote = '我已完成所有研究';
      if (fault === 'role') events[0]!.speaker = 'assistant';
      if (fault === 'time') Object.assign(events[0]!, { occurredAt: '2099-01-01T00:00:00.000Z' });
      if (fault === 'final-id') Object.assign(events[0]!, { id: 'final-model-id' });
    } });
    const result = await generateConversationMap(request, harness.deps);
    expect(result).toMatchObject({ truncated: true, omittedEventCount: 1 });
    const events = result.topics.flatMap(topic => topic.events);
    expect(events).toHaveLength(2);
    expect(events.flatMap(event => event.evidence).some(item => item.reference.entryId === 'Q14-0-user')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/我已完成所有研究|2099-01-01|final-model-id|invented/);
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.deps.revalidateReferences).toHaveBeenCalledOnce();
  });

  it('Q14 still fails when no model event has valid evidence', async () => {
    const harness = fixture(scenario('Q14'), { alterExtraction(events) {
      for (const event of events) event.evidence[0]!.evidenceId = 'invented';
    } });
    await expect(generateConversationMap(request, harness.deps)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.deps.revalidateReferences).not.toHaveBeenCalled();
  });
});
