import { describe, expect, it } from 'vitest';
import {
  ConversationMapEventSchema,
  ConversationMapResultSchema,
  ConversationMapResultV1Schema,
  ConversationMapResultV2Schema,
  ConversationTopicV2Schema,
  EvolutionEventSchema,
  type ConversationMapResultV2,
  type ConversationTopicV2,
  type EvolutionEvent
} from '../src/conversation-map';

const earlier = '2026-10-01T10:00:00.000Z';
const later = '2026-10-02T10:00:00.000Z';

function event(id: string, occurredAt = earlier): EvolutionEvent {
  return {
    id, topicId: 'topic-1', subjectKey: 'history-review', dimensionKey: 'trigger',
    eventType: 'constraint', speaker: 'user', state: 'considering', claim: '仅在用户请求时生成。',
    occurredAt, truncatedSource: false,
    evidence: [{ reference: { sessionId: `session-${id}`, entryId: `entry-${id}`, seq: 1,
      createdAt: occurredAt, role: 'user' }, quote: '仅在用户请求时生成' }]
  };
}

function topic(): ConversationTopicV2 {
  return {
    id: 'topic-1', title: '交流脉络', summary: '讨论历史回顾的生成方式。',
    events: [event('event-1'), event('event-2', later)],
    changes: [{ id: 'change-1', topicId: 'topic-1', fromEventId: 'event-1', toEventId: 'event-2',
      relation: 'refined', explanation: '用户明确了手动触发的约束。' }],
    insights: [{ id: 'insight-1', kind: 'key_change', text: '新增手动触发的约束。',
      supportingEventIds: ['event-1', 'event-2'], supportingChangeIds: ['change-1'] }],
    visibleEventIds: ['event-1', 'event-2']
  };
}

function result(): ConversationMapResultV2 {
  return {
    version: 2, generatedAt: later, rangeStart: '2026-10-01T00:00:00.000Z',
    rangeEnd: '2026-10-03T00:00:00.000Z', scopeKind: 'personal_main', analyzedTurnCount: 2,
    analyzedSessionCount: 2, modelCallCount: 2, truncated: false, omittedEventCount: 0,
    topics: [topic()]
  };
}

describe('conversation map versioned contracts', () => {
  it('keeps V1 compatible while parsing V2 results and completed events', () => {
    const v1 = { version: 1, generatedAt: later, rangeStart: earlier, rangeEnd: later,
      scopeKind: 'project', analyzedTurnCount: 0, analyzedSessionCount: 0, truncated: false, topics: [] };
    expect(ConversationMapResultV1Schema.parse(v1)).toEqual(v1);
    for (const candidate of [v1, result()]) {
      expect(ConversationMapResultSchema.parse(candidate)).toEqual(candidate);
      expect(ConversationMapEventSchema.parse({ type: 'conversation-map.completed', requestId: 'request', result: candidate }))
        .toMatchObject({ result: candidate });
    }
    expect(ConversationMapEventSchema.parse({ type: 'conversation-map.progress', requestId: 'request', phase: 'comparing' }))
      .toMatchObject({ phase: 'comparing' });
  });

  it('allows empty topics and empty changes without requiring invented insights', () => {
    expect(ConversationMapResultV2Schema.safeParse({ ...result(), topics: [] }).success).toBe(true);
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), changes: [], insights: [] }).success).toBe(true);
    expect(ConversationMapResultV2Schema.parse({ ...result(), omittedTurnCount: 2, truncated: true }).omittedTurnCount).toBe(2);
    expect(ConversationMapResultV2Schema.safeParse({ ...result(), omittedTurnCount: 801 }).success).toBe(false);
    expect(ConversationMapResultV2Schema.safeParse({ ...result(), omittedTurnCount: -1 }).success).toBe(false);
  });

  it('accepts optional reading summaries and labels without requiring migration of older events', () => {
    const valid = event('event-1');
    expect(EvolutionEventSchema.parse(valid)).toEqual(valid);
    const readable = { ...valid, summary: '仅在用户请求时生成。', subjectLabel: '交流脉络', dimensionLabel: '生成时机' };
    expect(EvolutionEventSchema.parse(readable)).toEqual(readable);
    for (const patch of [{ summary: '' }, { summary: 'x'.repeat(121) }, { subjectLabel: 'x'.repeat(81) }, { dimensionLabel: ' ' }]) {
      expect(EvolutionEventSchema.safeParse({ ...readable, ...patch }).success).toBe(false);
    }
  });

  it('requires nonempty evidence, claims, and exact quoted text', () => {
    const valid = event('event-1');
    for (const invalid of [
      { ...valid, evidence: [] }, { ...valid, claim: '   ' },
      { ...valid, evidence: [{ ...valid.evidence[0]!, quote: ' ' }] },
      { ...valid, evidence: [valid.evidence[0]!, valid.evidence[0]!] },
      { ...valid, claim: 'x'.repeat(241) }, { ...valid, extraModelField: 'untrusted' }
    ]) expect(EvolutionEventSchema.safeParse(invalid).success).toBe(false);
  });

  it('binds event time and speaker to the evidence and preserves user state distinctions', () => {
    const valid = event('event-1');
    expect(EvolutionEventSchema.safeParse({ ...valid, occurredAt: later }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...valid, speaker: 'assistant' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...valid, eventType: 'decision', state: 'planned' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...valid, eventType: 'action', state: 'planned' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...valid, eventType: 'decision', state: 'decided' }).success).toBe(true);
    expect(EvolutionEventSchema.safeParse({ ...valid, eventType: 'action', state: 'reported_done' }).success).toBe(true);
    const laterEvidence = event('later', later).evidence[0]!;
    expect(EvolutionEventSchema.safeParse({ ...valid, evidence: [laterEvidence, ...valid.evidence] }).success).toBe(true);
    expect(EvolutionEventSchema.safeParse({ ...valid, occurredAt: later, evidence: [...valid.evidence, laterEvidence] }).success).toBe(false);
    const assistant = { ...valid, speaker: 'assistant', evidence: valid.evidence.map(item => ({
      ...item, reference: { ...item.reference, role: 'assistant' }
    })) };
    expect(EvolutionEventSchema.safeParse({ ...assistant, eventType: 'option' }).success).toBe(true);
    expect(EvolutionEventSchema.safeParse({ ...assistant, eventType: 'decision', state: 'decided' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...assistant, eventType: 'option', state: 'reported_done' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...assistant, eventType: 'option', state: 'planned' }).success).toBe(false);
    expect(EvolutionEventSchema.safeParse({ ...valid, eventType: 'option', state: 'reported_done' }).success).toBe(false);
  });

  it('rejects dangling and cross-topic references in events, changes, and insights', () => {
    const valid = topic();
    const invalids = [
      { ...valid, events: [{ ...valid.events[0]!, topicId: 'elsewhere' }, valid.events[1]!] },
      { ...valid, changes: [{ ...valid.changes[0]!, topicId: 'elsewhere' }] },
      { ...valid, changes: [{ ...valid.changes[0]!, toEventId: 'missing' }] },
      { ...valid, insights: [{ ...valid.insights[0]!, supportingEventIds: ['missing'] }] },
      { ...valid, insights: [{ ...valid.insights[0]!, supportingChangeIds: ['missing'] }] },
      { ...valid, insights: [{ ...valid.insights[0]!, supportingEventIds: [], supportingChangeIds: [] }] },
      { ...valid, insights: [{ ...valid.insights[0]!, supportingChangeIds: [] }] },
      { ...valid, visibleEventIds: ['missing'] }
    ];
    for (const invalid of invalids) expect(ConversationTopicV2Schema.safeParse(invalid).success).toBe(false);
  });

  it('requires changes to compare independent sources on the same object and dimension in time order', () => {
    for (const patch of [{ subjectKey: 'other' }, { dimensionKey: 'other' }, { truncatedSource: true }]) {
      const candidate = topic();
      Object.assign(candidate.events[1]!, patch);
      expect(ConversationTopicV2Schema.safeParse(candidate).success).toBe(false);
    }
    const reversed = topic();
    Object.assign(reversed.changes[0]!, { fromEventId: 'event-2', toEventId: 'event-1' });
    expect(ConversationTopicV2Schema.safeParse(reversed).success).toBe(false);
    const repeatedSource = topic();
    repeatedSource.events[1] = { ...repeatedSource.events[0]!, id: 'event-2' };
    expect(ConversationTopicV2Schema.safeParse(repeatedSource).success).toBe(false);
    const assistantReason = topic();
    assistantReason.changes[0]!.reasonEvidence = [{ ...assistantReason.events[1]!.evidence[0]!,
      reference: { ...assistantReason.events[1]!.evidence[0]!.reference, role: 'assistant' } }];
    expect(ConversationTopicV2Schema.safeParse(assistantReason).success).toBe(false);
  });

  it('uses source sequence for equal-time messages only within the same session', () => {
    const candidate = topic();
    candidate.events[1] = { ...event('event-2'), evidence: [{ ...event('event-2').evidence[0]!,
      reference: { ...candidate.events[0]!.evidence[0]!.reference, entryId: 'entry-2', seq: 2 } }] };
    expect(ConversationTopicV2Schema.safeParse(candidate).success).toBe(true);
    candidate.events[1]!.evidence[0]!.reference.seq = 0;
    expect(ConversationTopicV2Schema.safeParse(candidate).success).toBe(false);
    candidate.events[1]!.evidence[0]!.reference.seq = 2;
    candidate.events[1]!.evidence[0]!.reference.sessionId = 'different-session';
    expect(ConversationTopicV2Schema.safeParse(candidate).success).toBe(false);
  });

  it('requires every source of an earlier event to precede every source of a later event', () => {
    const overlapping = topic();
    overlapping.events[0]!.evidence.push(event('event-3', '2026-10-03T10:00:00.000Z').evidence[0]!);
    expect(ConversationTopicV2Schema.safeParse(overlapping).success).toBe(false);
    const sharedEvidence = topic();
    sharedEvidence.events[1]!.evidence.push(sharedEvidence.events[0]!.evidence[0]!);
    sharedEvidence.events[1]!.occurredAt = earlier;
    expect(ConversationTopicV2Schema.safeParse(sharedEvidence).success).toBe(false);
    const sequenceReversal = topic();
    sequenceReversal.events[1]!.evidence[0]!.reference.sessionId = sequenceReversal.events[0]!.evidence[0]!.reference.sessionId;
    sequenceReversal.events[1]!.evidence[0]!.reference.seq = 0;
    expect(ConversationTopicV2Schema.safeParse(sequenceReversal).success).toBe(false);
  });

  it('keeps change endpoints visible as a pair and visible IDs unique', () => {
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), visibleEventIds: ['event-1'] }).success).toBe(false);
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), visibleEventIds: ['event-1', 'event-1', 'event-2'] }).success).toBe(false);
  });

  it('rejects duplicate IDs globally and sources outside the requested range', () => {
    const duplicate = result();
    duplicate.topics.push({ ...topic(), id: 'topic-2', events: topic().events.map(item => ({ ...item, topicId: 'topic-2' })),
      changes: topic().changes.map(item => ({ ...item, topicId: 'topic-2' })) });
    expect(ConversationMapResultV2Schema.safeParse(duplicate).success).toBe(false);
    const outsideRange = { ...result(), rangeStart: later };
    expect(ConversationMapResultV2Schema.safeParse(outsideRange).success).toBe(false);
    expect(ConversationMapResultV2Schema.safeParse({ ...result(), rangeEnd: earlier }).success).toBe(false);
  });

  it('requires V2 counters and enforces bounded event and visible node counts', () => {
    const missingOmissions = { ...result(), omittedEventCount: undefined };
    const missingCalls = { ...result(), modelCallCount: undefined };
    expect(ConversationMapResultV2Schema.safeParse(missingOmissions).success).toBe(false);
    expect(ConversationMapResultV2Schema.safeParse(missingCalls).success).toBe(false);
    const events = Array.from({ length: 21 }, (_, i) => event(`event-${i}`));
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), events, changes: [], insights: [] }).success).toBe(false);
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), events: events.slice(0, 10), changes: [], insights: [],
      visibleEventIds: events.slice(0, 9).map(item => item.id) }).success).toBe(false);
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), changes: Array(41).fill(topic().changes[0]) }).success).toBe(false);
    expect(ConversationTopicV2Schema.safeParse({ ...topic(), insights: Array(21).fill(topic().insights[0]) }).success).toBe(false);
  });
});
