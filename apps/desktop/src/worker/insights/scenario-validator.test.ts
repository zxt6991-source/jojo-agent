import { describe, expect, it } from 'vitest';
import type { EvolutionEvent } from '@desktop-agent/contracts';
import { validateInsightCards } from './insight-validator';
import { insightStrategy, isSecondOrderEvent } from './strategies/registry';

function inquiry(overrides: Partial<EvolutionEvent> = {}): EvolutionEvent {
  const quote = '有没有适合长期持有的债基';
  return {
    id: 'question-1', topicId: 'topic-1', subjectKey: '债基', dimensionKey: '持有期限',
    eventType: 'exploration', speaker: 'user', state: 'exploring', claim: quote,
    occurredAt: '2026-11-01T10:00:00.000Z', truncatedSource: false,
    evidence: [{ reference: { sessionId: 's1', entryId: 'u1', seq: 1, role: 'user', createdAt: '2026-11-01T10:00:00.000Z' }, quote }],
    ...overrides
  };
}
const card = {
  title: '持有期限可能影响资金安排',
  explanation: '假如选择长期持有，资金可用时间可能变化，随后可能影响其他支出的安排。',
  nature: 'hypothesis', uncertainty: '取决于具体产品和资金需求。', verificationQuestion: '何时需要使用这笔资金？',
  supportingEventIds: ['question-1'], scenarioEvidence: { eventId: 'question-1', exactQuote: '长期持有的债基' }
};
const withoutScenario = () => {
  const value: Record<string, unknown> = { ...card };
  delete value.scenarioEvidence;
  return value;
};

describe('second-order inquiry scenarios', () => {
  it.each(['exploration', 'open_question'] as const)('admits a concrete %s without reclassifying it as a choice', eventType => {
    const event = inquiry({ eventType });
    expect(isSecondOrderEvent(event)).toBe(false);
    expect(insightStrategy('second_order').selectEvents([event])).toEqual([event]);
    const output = validateInsightCards({ cards: [card] }, [event], 'second_order');
    expect(output.omittedCardCount).toBe(0);
    expect(output.cards).toHaveLength(1);
    expect(output.cards[0]).not.toHaveProperty('scenarioEvidence');
    expect(output.cards[0]!.supportingReferences).toEqual([event.evidence[0]!.reference]);
    expect(output.cards[0]!.explanation).toContain('假如选择用户提问中「长期持有的债基」所指的方案');
    expect(output.cards[0]!.uncertainty).toContain('原文不能确定用户是否作出决定或执行');
  });

  it('requires scenario grounding even after a factual inquiry was admitted for inspection', () => {
    const event = inquiry({ claim: '看看最近的运动情况', evidence: [{ ...inquiry().evidence[0]!, quote: '看看最近的运动情况' }] });
    expect(insightStrategy('second_order').selectEvents([event])).toEqual([event]);
    expect(validateInsightCards({ cards: [withoutScenario()] }, [event], 'second_order')).toEqual({ cards: [], omittedCardCount: 1 });
    expect(validateInsightCards({ cards: [] }, [event], 'second_order')).toEqual({ cards: [], omittedCardCount: 0 });
  });

  it.each(['missing', 'forged-id', 'unquoted-text', 'claim-only', 'unsupported-id', 'assistant', 'not-an-inquiry', 'blank', 'extra-field'])(
    'rejects %s scenario support', fault => {
      let events = [inquiry()];
      let candidate: Record<string, unknown> = { ...card, scenarioEvidence: { ...card.scenarioEvidence } };
      if (fault === 'missing') candidate = withoutScenario();
      if (fault === 'forged-id') candidate.scenarioEvidence = { ...card.scenarioEvidence, eventId: 'forged' };
      if (fault === 'unquoted-text') candidate.scenarioEvidence = { ...card.scenarioEvidence, exactQuote: '短期买卖的股票' };
      if (fault === 'claim-only') {
        events = [inquiry({ claim: '长期持有的债基', evidence: [{ ...inquiry().evidence[0]!, quote: '查看我的投资概况' }] })];
      }
      if (fault === 'unsupported-id') {
        events.push(inquiry({ id: 'question-2' }));
        candidate.scenarioEvidence = { ...card.scenarioEvidence, eventId: 'question-2' };
      }
      if (fault === 'assistant') {
        events = [inquiry({ speaker: 'assistant', evidence: [{ ...inquiry().evidence[0]!, reference: { ...inquiry().evidence[0]!.reference, role: 'assistant' } }] })];
      }
      if (fault === 'not-an-inquiry') events = [inquiry({ eventType: 'constraint', state: 'unknown' })];
      if (fault === 'blank') candidate.scenarioEvidence = { ...card.scenarioEvidence, exactQuote: '   ' };
      if (fault === 'extra-field') candidate.scenarioEvidence = { ...card.scenarioEvidence, chosen: true };
      for (const perspective of ['second_order', 'reverse_thinking'] as const) {
        expect(validateInsightCards({ cards: [candidate] }, events, perspective)).toEqual({ cards: [], omittedCardCount: 1 });
      }
    });

  it('does not use an assistant reference disguised as user inquiry evidence', () => {
    const event = inquiry({ evidence: [{ ...inquiry().evidence[0]!, reference: { ...inquiry().evidence[0]!.reference, role: 'assistant' } }] });
    expect(validateInsightCards({ cards: [card] }, [event], 'second_order').cards).toEqual([]);
  });

  it('rejects unrelated inquiry topics as support for the same scenario', () => {
    const unrelated = inquiry({ id: 'question-2', topicId: 'topic-2' });
    const candidate = { ...card, supportingEventIds: ['question-1', 'question-2'] };
    expect(validateInsightCards({ cards: [candidate] }, [inquiry(), unrelated], 'second_order')).toEqual({ cards: [], omittedCardCount: 1 });
  });

  it.each(['option', 'decision', 'revision'] as const)('keeps an explicit %s compatible without scenario metadata', eventType => {
    const event = inquiry({ eventType, state: eventType === 'decision' ? 'decided' : 'considering' });
    expect(validateInsightCards({ cards: [withoutScenario()] }, [event], 'second_order').cards).toHaveLength(1);
  });

  it('validates supplied scenario metadata even when an explicit decision is also cited', () => {
    const decision = inquiry({ id: 'choice-1', eventType: 'decision', state: 'decided' });
    const candidate = { ...card, supportingEventIds: ['question-1', 'choice-1'] };
    const grounded = validateInsightCards({ cards: [candidate] }, [inquiry(), decision], 'second_order');
    expect(grounded.cards[0]!.explanation).toContain('假如选择用户提问中');
    expect(validateInsightCards({ cards: [{ ...candidate, scenarioEvidence: { eventId: 'forged', exactQuote: '长期持有的债基' } }] }, [inquiry(), decision], 'second_order').cards).toEqual([]);
  });

  it.each(['blind_spots'] as const)('does not accept scenario metadata for %s', perspective => {
    const sources = [inquiry(), inquiry({ id: 'position-1', eventType: 'position', state: 'unknown' })];
    const candidate = { ...card, supportingEventIds: ['question-1', 'position-1'], nature: perspective === 'blind_spots' ? 'suggestion' : 'hypothesis' };
    expect(validateInsightCards({ cards: [candidate] }, sources, perspective).cards).toEqual([]);
  });

  it.each(['继续', '你好！', '谢谢。', '好的', 'OK', '重试'])('filters trivial inquiry %s before analysis', quote => {
    const event = inquiry({ claim: quote, evidence: [{ ...inquiry().evidence[0]!, quote }] });
    expect(insightStrategy('second_order').selectEvents([event])).toEqual([]);
    expect(validateInsightCards({ cards: [{ ...card, scenarioEvidence: { eventId: event.id, exactQuote: quote } }] }, [event], 'second_order').cards).toEqual([]);
  });
});

describe('reverse-thinking inquiry grounding', () => {
  it.each(['exploration', 'open_question', 'option'] as const)('analyzes a user %s as a model-proposed hypothesis without reclassifying the source', eventType => {
    const event = inquiry({ eventType });
    expect(insightStrategy('reverse_thinking').selectEvents([event])).toEqual([event]);
    const output = validateInsightCards({ cards: [card] }, [event], 'reverse_thinking');
    expect(output.cards).toHaveLength(1);
    expect(output.cards[0]).toMatchObject({ nature: 'hypothesis', supportingReferences: [event.evidence[0]!.reference] });
    expect(output.cards[0]!.explanation).toContain('「长期持有的债基」提出的反向假设（尚未验证）');
    expect(output.cards[0]!.uncertainty).toContain('此假设由模型提出');
    expect(output.cards[0]).not.toHaveProperty('scenarioEvidence');
    expect(event.eventType).toBe(eventType);
    expect(validateInsightCards({ cards: [withoutScenario()] }, [event], 'reverse_thinking').cards).toEqual([]);
  });

  it('does not combine a query with unrelated topics or accept a false role', () => {
    const unrelated = inquiry({ id: 'other', topicId: 'other', eventType: 'decision', state: 'decided' });
    expect(validateInsightCards({ cards: [{ ...card, supportingEventIds: ['question-1', 'other'] }] }, [inquiry(), unrelated], 'reverse_thinking').cards).toEqual([]);
    const assistant = inquiry({ evidence: [{ ...inquiry().evidence[0]!, reference: { ...inquiry().evidence[0]!.reference, role: 'assistant' } }] });
    expect(validateInsightCards({ cards: [card] }, [assistant], 'reverse_thinking').cards).toEqual([]);
  });

  it.each(['你认为长期持有就一定安全', '用户已持有债基', '你忽略了回撤', 'You believe holding longer is safer'])('rejects unsupported attribution: %s', explanation => {
    expect(validateInsightCards({ cards: [{ ...card, explanation }] }, [inquiry()], 'reverse_thinking').cards).toEqual([]);
  });

  it.each(['继续', '你好！', '谢谢。', '好的', 'OK', '重试'])('does not fabricate a hypothesis for %s', quote => {
    const event = inquiry({ claim: quote, evidence: [{ ...inquiry().evidence[0]!, quote }] });
    expect(insightStrategy('reverse_thinking').selectEvents([event])).toEqual([]);
    expect(validateInsightCards({ cards: [{ ...card, scenarioEvidence: { eventId: event.id, exactQuote: quote } }] }, [event], 'reverse_thinking').cards).toEqual([]);
  });
});
