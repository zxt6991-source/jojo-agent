import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurnRecord, EvolutionEvent, InsightGenerateInput, MessageReference } from '@desktop-agent/contracts';
import { createInsightService, INSIGHT_LIMITS, type InsightDependencies } from './insight-service';
import { InsightSemanticCache } from './insight-cache';
import { validateInsightCards } from './insight-validator';
import { ConversationMapServiceError } from '../conversation-map-service';
import { insightStrategy } from './strategies/registry';

const now = new Date('2026-10-26T08:01:23.456Z');
const request: InsightGenerateInput = { requestId: 'insight-1', range: '30d', scope: { kind: 'personal_main' }, perspective: 'reverse_thinking' };
function turn(index: number, at = now.getTime() - 86_400_000 + index * 2000): ConversationTurnRecord {
  const timestamp = new Date(at).toISOString();
  return { sessionId: 'session-1', turnId: `turn-${index}`, createdAt: timestamp, truncated: false,
    user: { reference: { sessionId: 'session-1', entryId: `user-${index}`, seq: index * 2, createdAt: timestamp, role: 'user' }, text: `我决定采用本地方案 ${index}，预算为 ${index + 1} 万元。`, truncated: false },
    assistants: [{ reference: { sessionId: 'session-1', entryId: `assistant-${index}`, seq: index * 2 + 1, createdAt: new Date(at + 1000).toISOString(), role: 'assistant' }, text: `AI 建议检查方案 ${index} 的长期维护成本。`, truncated: false }]
  };
}
function modelCard(ids = ['v1'], nature = 'hypothesis') {
  return { title: '维护开销可能改变成本假设', explanation: '如果维护时间明显增加，直接成本可能上升，随后可能影响预算分配。', nature,
    uncertainty: '实际使用频率和维护时间仍需测量。', verificationQuestion: '能否先记录一周的维护工时？', supportingEventIds: ids };
}
function completion(prompt: string): string {
  if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) {
    const marker = '\nUNTRUSTED_INSIGHT_EVENTS_JSON\n';
    const events = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as EvolutionEvent[];
    return JSON.stringify({ cards: [modelCard([events[0]!.id], prompt.includes('Perspective: blind_spots') ? 'suggestion' : 'hypothesis')] });
  }
  if (prompt.includes('TASK: COMPARE.')) return '{"changes":[]}';
  if (prompt.includes('TASK: VERIFY_SUMMARIES.')) return '{"reviews":[]}';
  const marker = '\nUNTRUSTED_CONVERSATION_DATA_JSON\n';
  if (prompt.includes('TASK: MERGE.')) {
    const topics = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as { id: string }[];
    return JSON.stringify({ groups: topics.map(topic => ({ memberIds: [topic.id] })) });
  }
  const inputs = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as { messages: { id: string; text: string; reference: MessageReference }[] }[];
  return JSON.stringify({ events: inputs.flatMap(input => input.messages.filter(message => message.reference.role === 'user')).map(message => ({
    topicLabel: '本地方案预算', subjectLabel: '本地方案', dimensionLabel: '方案选择', eventType: 'decision', speaker: 'user', state: 'decided',
    claim: message.text, evidence: [{ evidenceId: message.id, exactQuote: message.text }]
  })) });
}
function completionWithAssistantContext(prompt: string): string {
  const output = JSON.parse(completion(prompt));
  if (prompt.includes('TASK: EXTRACT.')) {
    const marker = '\nUNTRUSTED_CONVERSATION_DATA_JSON\n';
    const inputs = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as { messages: { id: string; text: string; reference: MessageReference }[] }[];
    output.events.push(...inputs.flatMap(input => input.messages.filter(message => message.reference.role === 'assistant')).slice(0, 40 - output.events.length).map(message => ({
      topicLabel: '本地方案预算', subjectLabel: '本地方案', dimensionLabel: '维护成本', eventType: 'option', speaker: 'assistant', state: 'considering',
      claim: message.text.slice(0, 240), evidence: [{ evidenceId: message.id, exactQuote: message.text.slice(0, 240) }]
    })));
  }
  return JSON.stringify(output);
}
function insightPromptData(prompt: string) {
  const contextMarker = '\nUNTRUSTED_ASSISTANT_CONTEXT_JSON\n';
  const userMarker = '\nUNTRUSTED_INSIGHT_EVENTS_JSON\n';
  const userStart = prompt.lastIndexOf(userMarker);
  const contextJson = prompt.slice(prompt.lastIndexOf(contextMarker) + contextMarker.length, userStart).trim();
  const userJson = prompt.slice(userStart + userMarker.length).trim();
  return { context: JSON.parse(contextJson) as { topicId: string; speaker: string; claim: string; id?: string }[], users: JSON.parse(userJson) as EvolutionEvent[], contextJson, userJson };
}
function dependencies(turns = [turn(1), turn(2)]): InsightDependencies {
  return {
    userDataOwner: 'owner-1', modelId: 'provider-1:model-1', signal: new AbortController().signal, now: () => now,
    readPage: vi.fn(query => {
      const available = turns.filter(item => Date.parse(item.createdAt) >= Date.parse(query.rangeStart) && Date.parse(item.createdAt) < Date.parse(query.rangeEnd));
      const offset = query.cursor ? available.findIndex(item => item.user.reference.seq === query.cursor!.seq) + 1 : 0;
      const items = available.slice(offset, offset + query.limit);
      const hasMore = offset + items.length < available.length;
      const last = items.at(-1);
      return { turns: items, hasMore, ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, sessionId: last.sessionId, seq: last.user.reference.seq } } : {}) };
    }),
    historyFingerprint: vi.fn(query => createHash('sha256').update(JSON.stringify(turns.filter(item => Date.parse(item.createdAt) >= Date.parse(query.rangeStart) && Date.parse(item.createdAt) < Date.parse(query.rangeEnd)))).digest('hex')),
    complete: vi.fn(async prompt => completion(prompt)),
    revalidateReferences: vi.fn(refs => refs), onSourcesValidated: vi.fn(), onMetrics: vi.fn()
  };
}
const extractCalls = (deps: InsightDependencies) => vi.mocked(deps.complete).mock.calls.filter(([prompt]) => prompt.includes('TASK: EXTRACT.')).length;

describe('isolated insight service and shared semantic cache', () => {
  it.each(['reverse_thinking', 'second_order', 'blind_spots'] as const)('reports actual work before model calls for %s and describes cache reuse', async perspective => {
    const deps = dependencies();
    const onProgress = vi.fn();
    deps.onProgress = onProgress;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const phase = prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') ? 'analyzing' : 'extracting';
      expect(onProgress.mock.lastCall?.[0]).toBe(phase);
      expect(onProgress.mock.lastCall?.[1]).toBe(0);
      expect(onProgress.mock.lastCall?.[3]).toBeTruthy();
      return completion(prompt);
    });
    vi.mocked(deps.revalidateReferences).mockImplementation(refs => {
      expect(onProgress.mock.lastCall?.[0]).toBe('validating');
      return refs;
    });
    const service = createInsightService();
    await service.generate({ ...request, perspective }, deps);
    expect(onProgress).toHaveBeenCalledWith('reading', 2, undefined, expect.stringContaining('已读取 2 轮对话'));
    expect(onProgress).toHaveBeenCalledWith('merging', undefined, undefined, expect.stringContaining('已整理为 1 个主题'));
    expect(onProgress).toHaveBeenCalledWith('analyzing', 0, 1, expect.stringContaining('2 条用户事件'));
    onProgress.mockClear();
    await service.generate({ ...request, perspective }, deps);
    expect(onProgress).toHaveBeenCalledWith('reading', undefined, undefined, '已确认历史范围，找到可复用的分析记录。');
    expect(onProgress).toHaveBeenCalledWith('extracting', undefined, undefined, expect.stringContaining('已复用 2 轮对话'));
    expect(onProgress).toHaveBeenCalledWith('merging', undefined, undefined, expect.stringContaining('已复用 1 个主题'));
    expect(onProgress.mock.calls.flat().join(' ')).not.toContain(turn(1).user.text);
  });

  it('announces analysis retries without surfacing invalid model output', async () => {
    const deps = dependencies();
    const onProgress = vi.fn(); deps.onProgress = onProgress;
    let analysisCalls = 0;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') && ++analysisCalls === 1) return 'private invalid provider response';
      return completion(prompt);
    });
    await createInsightService().generate(request, deps);
    expect(onProgress).toHaveBeenCalledWith('analyzing', 0, 1, expect.stringContaining('正在重试分析'));
    expect(onProgress.mock.calls.flat().join(' ')).not.toContain('private invalid provider response');
    expect(analysisCalls).toBe(2);
  });

  it('does not claim model analysis when no eligible history exists', async () => {
    const deps = dependencies([]);
    const onProgress = vi.fn(); deps.onProgress = onProgress;
    await createInsightService().generate(request, deps);
    expect(onProgress.mock.calls.some(([phase]) => phase === 'analyzing')).toBe(false);
    expect(onProgress).toHaveBeenLastCalledWith('validating', undefined, undefined, expect.stringContaining('未提取到适合当前视角'));
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each(['reverse_thinking', 'second_order', 'blind_spots'] as const)('generates %s using only program-mapped evidence and explicit uncertainty', async perspective => {
    const deps = dependencies();
    const result = await createInsightService().generate({ ...request, perspective }, deps);
    expect(result).toMatchObject({ perspective, analyzedTurnCount: 2, analyzedSessionCount: 1, modelCallCount: 2, semanticCacheHit: false, rangeEnd: now.toISOString() });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([turn(2).user.reference]);
    expect(result.cards[0]!.explanation).toContain(perspective === 'blind_spots' ? '依据本次可核验的记录，仍值得补充确认' : '尚未验证');
    expect(result.cards[0]!.verificationQuestion).toContain('维护工时');
    expect(deps.onSourcesValidated).toHaveBeenCalledWith(expect.arrayContaining([{ reference: turn(1).user.reference, text: turn(1).user.text }]));
    expect(deps.onMetrics).toHaveBeenCalledWith({ perspective, modelCallCount: 2, analyzedTurnCount: 2, semanticCacheHit: false,
      extractedEventCount: 2, omittedEventCount: 0, omittedTurnCount: 0, sourceTruncated: false,
      userEventCount: 2, assistantEventCount: 0,
      eligibleEventCount: 2, selectedEventCount: 2, omittedCardCount: 0, cardCount: 1,
      truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 0, omittedAssistantMessageCount: 0,
      unknownSourceTruncation: false, analysisPerformed: true });
    const prompt = vi.mocked(deps.complete).mock.calls.at(-1)![0];
    expect(prompt).toContain('UNTRUSTED');
    expect(prompt).toContain('不是历史事实');
  });

  it('reuses all semantic events across perspectives after minutes, with precise current dates', async () => {
    const service = createInsightService();
    const deps = dependencies();
    await service.generate(request, deps);
    const later = new Date(now.getTime() + 3 * 60_000 + 789);
    deps.now = () => later;
    const result = await service.generate({ ...request, perspective: 'second_order' }, deps);
    expect(result).toMatchObject({ semanticCacheHit: true, modelCallCount: 1, rangeEnd: later.toISOString(), rangeStart: new Date(later.getTime() - 30 * 86_400_000).toISOString() });
    expect(extractCalls(deps)).toBe(1);
    expect(deps.readPage).toHaveBeenCalledTimes(1);
    expect(deps.historyFingerprint).toHaveBeenCalledTimes(4);
    expect(deps.revalidateReferences).toHaveBeenCalledTimes(2);
  });

  it('includes just-created history up to the exact requested instant', async () => {
    const deps = dependencies([turn(1, now.getTime() - 2000)]);
    const result = await createInsightService().generate(request, deps);
    expect(result.analyzedTurnCount).toBe(1);
    expect(result.rangeEnd).toBe(now.toISOString());
  });

  it('invalidates when an old message leaves the rolling window', async () => {
    const deps = dependencies([turn(1, now.getTime() - 30 * 86_400_000 + 60_000), turn(2)]);
    const service = createInsightService();
    await service.generate(request, deps);
    deps.now = () => new Date(now.getTime() + 2 * 60_000);
    const result = await service.generate({ ...request, perspective: 'second_order' }, deps);
    expect(result.semanticCacheHit).toBe(false);
    expect(result.analyzedTurnCount).toBe(1);
    expect(extractCalls(deps)).toBe(2);
    expect(result.cards.flatMap(card => card.supportingReferences).every(ref => ref.entryId === 'user-2')).toBe(true);
  });

  it.each(['edit', 'delete', 'append'] as const)('invalidates current history after %s', async change => {
    const turns = [turn(1), turn(2)];
    const deps = dependencies(turns);
    const service = createInsightService();
    await service.generate(request, deps);
    if (change === 'edit') turns[0]!.user.text += ' 维护预算已经调整。';
    if (change === 'delete') turns.shift();
    if (change === 'append') turns.push(turn(3));
    const result = await service.generate(request, deps);
    expect(result.semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(2);
  });

  it.each(['userDataOwner', 'modelId'] as const)('isolates cache by %s', async field => {
    const service = createInsightService();
    const deps = dependencies();
    await service.generate(request, deps);
    deps[field] = 'different';
    expect((await service.generate(request, deps)).semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(2);
  });

  it('shares uncropped extraction from conversation maps with subsequent new views', async () => {
    const service = createInsightService();
    const deps = dependencies(Array.from({ length: 31 }, (_, index) => turn(index + 1)));
    const mapDeps = { ...deps, onProgress: () => undefined };
    const map = await service.generateConversationMap({ range: request.range, scope: request.scope }, mapDeps);
    expect(map.topics[0]!.events).toHaveLength(20);
    expect(extractCalls(deps)).toBe(2);
    const result = await service.generate(request, deps);
    expect(result.semanticCacheHit).toBe(true);
    expect(extractCalls(deps)).toBe(2);
    const prompt = vi.mocked(deps.complete).mock.calls.at(-1)![0];
    const marker = '\nUNTRUSTED_INSIGHT_EVENTS_JSON\n';
    const events = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as EvolutionEvent[];
    expect(events).toHaveLength(31);
  });

  it('lets the existing conversation map reuse extraction from a new view', async () => {
    const service = createInsightService();
    const deps = dependencies();
    await service.generate(request, deps);
    const mapDeps = { ...deps, onProgress: () => undefined };
    const map = await service.generateConversationMap({ range: request.range, scope: request.scope }, mapDeps);
    expect(map.topics[0]!.events).toHaveLength(2);
    expect(extractCalls(deps)).toBe(1);
    expect(deps.onMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ perspective: 'conversation_map', semanticCacheHit: true }));
  });

  it('groups related stages before blind-spot analysis and shares that grouping across views', async () => {
    const inputs = [turn(1), turn(2)];
    const deps = dependencies(inputs);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('TASK: MERGE.')) return '{"groups":[{"memberIds":["t1","t2"]}]}';
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) {
        output.events[0].topicLabel = '本地方案的预算';
        output.events[1].topicLabel = '本地方案的维护';
      }
      return JSON.stringify(output);
    });
    const service = createInsightService();
    const result = await service.generate({ ...request, perspective: 'blind_spots' }, deps);
    expect(result).toMatchObject({ modelCallCount: 3, truncated: false,
      coverage: { extractedEventCount: 2, eligibleEventCount: 2, selectedEventCount: 2, analysisPerformed: true } });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([inputs[1]!.user.reference]);
    const mergePrompt = vi.mocked(deps.complete).mock.calls.find(([prompt]) => prompt.includes('TASK: MERGE.'))![0];
    expect(mergePrompt).toContain('SAME concrete user task');
    await service.generate({ ...request, perspective: 'second_order' }, deps);
    const map = await service.generateConversationMap({ range: request.range, scope: request.scope }, { ...deps, onProgress: () => undefined });
    expect(map.topics).toHaveLength(1);
    expect(extractCalls(deps)).toBe(1);
    expect(vi.mocked(deps.complete).mock.calls.filter(([prompt]) => prompt.includes('TASK: MERGE.'))).toHaveLength(1);
  });

  it('keeps separate single-message tasks available without combining their sources', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) {
        output.events[0].topicLabel = '本地方案';
        output.events[1].topicLabel = '跑步训练';
        output.events[1].subjectLabel = '跑步';
      }
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate({ ...request, perspective: 'blind_spots' }, deps);
    expect(result).toMatchObject({
      modelCallCount: 3,
      coverage: { extractedEventCount: 2, eligibleEventCount: 2, selectedEventCount: 2, analysisPerformed: true }
    });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([turn(2).user.reference]);
  });

  it.each(['exploration', 'open_question'] as const)('analyzes a concrete single-message %s without treating it as a belief or commitment', async eventType => {
    const input = turn(1);
    input.user.text = '本地部署模型的维护成本应该从哪些方面评估？';
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) {
        output.events[0].eventType = eventType;
        output.events[0].state = eventType === 'exploration' ? 'exploring' : 'unknown';
      }
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate({ ...request, perspective: 'blind_spots' }, deps);
    expect(result).toMatchObject({ modelCallCount: 2,
      coverage: { extractedEventCount: 1, eligibleEventCount: 1, selectedEventCount: 1, analysisPerformed: true } });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([input.user.reference]);
    const prompt = vi.mocked(deps.complete).mock.calls.find(([value]) => value.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))![0];
    expect(prompt).toContain('用户提问或请求只是分析对象');
    expect(prompt).toContain('绝不等于用户已持有某种观点');
    expect(prompt).toContain('不要求多轮讨论');
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\nUNTRUSTED_INSIGHT_EVENTS_JSON\n') + '\nUNTRUSTED_INSIGHT_EVENTS_JSON\n'.length))[0]).toMatchObject({ eventType });
  });

  it('shows related AI replies as partial context without changing user citations or model calls', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => completionWithAssistantContext(prompt));
    const result = await createInsightService().generate({ ...request, perspective: 'blind_spots' }, deps);
    expect(result).toMatchObject({ modelCallCount: 2, coverage: { userEventCount: 2, assistantEventCount: 2, selectedEventCount: 2 } });
    expect(result.cards[0]!.supportingReferences).toEqual([turn(2).user.reference]);
    const prompt = vi.mocked(deps.complete).mock.calls.find(([value]) => value.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))![0];
    const { context, users } = insightPromptData(prompt);
    expect(context.map(event => event.claim)).toEqual([turn(2).assistants[0]!.text, turn(1).assistants[0]!.text]);
    expect(context.every(event => !('id' in event) && event.speaker === 'assistant')).toBe(true);
    expect(users.every(event => event.speaker === 'user')).toBe(true);
    expect(prompt).toContain('只用于避免重复已有解释或建议');
    expect(prompt).toContain('不等于用户已接受');
    expect(prompt).toContain('不等于真实世界事实已核实');
    expect(prompt).toContain('不代表完整聊天');
  });

  it('excludes unrelated AI topics and leaves other perspectives without assistant context', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completionWithAssistantContext(prompt));
      if (prompt.includes('TASK: EXTRACT.')) output.events.at(-1).topicLabel = '无关训练计划';
      return JSON.stringify(output);
    });
    const service = createInsightService();
    await service.generate({ ...request, perspective: 'blind_spots' }, deps);
    const blindPrompt = vi.mocked(deps.complete).mock.calls.find(([value]) => value.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))![0];
    const { context, users } = insightPromptData(blindPrompt);
    expect(context).toHaveLength(1);
    expect(context[0]!.claim).toBe(turn(1).assistants[0]!.text);
    expect(context.every(event => users.some(user => user.topicId === event.topicId))).toBe(true);
    await service.generate(request, deps);
    const reversePrompt = vi.mocked(deps.complete).mock.calls.at(-1)![0];
    expect(reversePrompt).toContain('Perspective: reverse_thinking');
    expect(reversePrompt).not.toContain('UNTRUSTED_ASSISTANT_CONTEXT_JSON');
  });

  it('rejects a blind-spot card citing an AI event even when that reply appears in context', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')
      ? JSON.stringify({ cards: [modelCard(['v3'], 'suggestion')] }) : completionWithAssistantContext(prompt));
    await expect(createInsightService().generate({ ...request, perspective: 'blind_spots' }, deps)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    const attempts = vi.mocked(deps.complete).mock.calls.filter(([prompt]) => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'));
    expect(attempts).toHaveLength(2);
    expect(insightPromptData(attempts[0]![0]).context).toHaveLength(2);
  });

  it.each(['events', 'characters'] as const)('keeps combined user and AI context within the %s budget', async budget => {
    const inputs = Array.from({ length: budget === 'events' ? 50 : 70 }, (_, index) => {
      const input = turn(index + 1);
      if (budget === 'characters') {
        input.user.text = `我决定采用本地方案${index}，${'维护要求需要逐项确认。'.repeat(20)}`;
        input.assistants[0]!.text = `AI 建议检查方案${index}的长期维护成本，${'应评估维护人员投入和运行费用。'.repeat(15)}`;
      }
      return input;
    });
    const deps = dependencies(inputs);
    vi.mocked(deps.complete).mockImplementation(async prompt => completionWithAssistantContext(prompt));
    const result = await createInsightService().generate({ ...request, perspective: 'blind_spots' }, deps);
    const prompt = vi.mocked(deps.complete).mock.calls.find(([value]) => value.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))![0];
    const { context, users, contextJson, userJson } = insightPromptData(prompt);
    expect(context.length + users.length).toBeLessThanOrEqual(INSIGHT_LIMITS.events);
    expect(contextJson.length + userJson.length).toBeLessThanOrEqual(INSIGHT_LIMITS.inputChars);
    expect(prompt.slice(prompt.lastIndexOf('\nUNTRUSTED_ASSISTANT_CONTEXT_JSON\n')).length).toBeLessThanOrEqual(INSIGHT_LIMITS.inputChars);
    expect(result.coverage!.selectedEventCount).toBe(users.length);
    if (budget === 'events') expect(context.length + users.length).toBe(INSIGHT_LIMITS.events);
    else expect(users.length).toBeLessThan(inputs.length);
  });

  it('does not cache failed grouping or treat it as a complete negative finding', async () => {
    const deps = dependencies();
    let groupingFails = true;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (groupingFails && prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) return '{"cards":[]}';
      if (prompt.includes('TASK: MERGE.')) return groupingFails
        ? '{"groups":[{"memberIds":["t1","t1"]}]}'
        : '{"groups":[{"memberIds":["t1","t2"]}]}';
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) output.events.forEach((event: { topicLabel: string }, index: number) => { event.topicLabel = `本地方案阶段${index}`; });
      return JSON.stringify(output);
    });
    const service = createInsightService();
    expect(await service.generate({ ...request, perspective: 'blind_spots' }, deps)).toMatchObject({
      cards: [], modelCallCount: 4, semanticCacheHit: false, truncated: true, emptyReason: 'incomplete_analysis',
      coverage: { extractedEventCount: 2, eligibleEventCount: 2, analysisPerformed: true, topicGroupingIncomplete: true }
    });
    groupingFails = false;
    const recovered = await service.generate({ ...request, perspective: 'blind_spots' }, deps);
    expect(recovered).toMatchObject({ semanticCacheHit: false, truncated: false, coverage: { eligibleEventCount: 2 } });
    expect(recovered.cards).toHaveLength(1);
    expect(await service.generate({ ...request, perspective: 'blind_spots' }, deps)).toMatchObject({ semanticCacheHit: true });
    expect(extractCalls(deps)).toBe(2);
  });

  it('accepts and caches a legitimately empty history without a model call', async () => {
    const service = createInsightService();
    const deps = dependencies([]);
    expect(await service.generate(request, deps)).toMatchObject({ cards: [], analyzedTurnCount: 0, modelCallCount: 0, semanticCacheHit: false });
    expect(await service.generate({ ...request, perspective: 'blind_spots' }, deps)).toMatchObject({ cards: [], semanticCacheHit: true });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('accepts a model choosing zero cards without inventing replacement content', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') ? '{"cards":[]}' : completion(prompt));
    expect(await createInsightService().generate(request, deps)).toMatchObject({ cards: [], truncated: false });
  });

  it('can examine an explicit revised choice even when the earlier choice is outside the selected history', async () => {
    const input = turn(1); input.user.text = '我决定改为采用本地方案，预算仍为2万元。';
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) output.events.forEach((event: { eventType: string }) => { event.eventType = 'revision'; });
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate(request, deps);
    expect(result).toMatchObject({ truncated: false, modelCallCount: 2 });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([input.user.reference]);
    expect(deps.onMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ extractedEventCount: 1, eligibleEventCount: 1, selectedEventCount: 1 }));
  });

  it.each([0, 9])('analyzes a contemplated option in a user inquiry even with %i rejected candidates', async omitted => {
    const input = turn(1);
    input.user.text = '有没有适合长期持有的债基';
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) {
        Object.assign(output.events[0], { eventType: 'exploration', state: 'exploring' });
        output.events.push(...Array.from({ length: omitted }, () => ({ invalid: true })));
      }
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) {
        output.cards[0].scenarioEvidence = { eventId: output.cards[0].supportingEventIds[0], exactQuote: '长期持有的债基' };
        output.cards[0].explanation = '假如选择长期持有债基，资金用途可能受到持有期限影响，随后可能影响短期资金安排。';
        output.cards[0].uncertainty = '具体期限和资金用途仍待确认。';
        output.cards[0].verificationQuestion = '这部分资金是否有确定的使用时间？';
      }
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate({ ...request, perspective: 'second_order' }, deps);
    expect(result).toMatchObject({ truncated: omitted > 0,
      coverage: { extractedEventCount: 1, userEventCount: 1, eligibleEventCount: 1, selectedEventCount: 1, analysisPerformed: true, omittedEventCount: omitted } });
    expect(result.cards).toHaveLength(1);
    expect(result.emptyReason).toBeUndefined();
    expect(result.cards[0]!.supportingReferences).toEqual([input.user.reference]);
    expect(result.cards[0]!.explanation).toContain('长期持有的债基');
    expect(result.cards[0]).not.toHaveProperty('scenarioEvidence');
    const prompt = vi.mocked(deps.complete).mock.calls.find(([text]) => text.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))![0];
    const marker = '\nUNTRUSTED_INSIGHT_EVENTS_JSON\n';
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))[0]).toMatchObject({ eventType: 'exploration', state: 'exploring' });
  });

  it.each(['second_order', 'reverse_thinking'] as const)('lets %s decline a factual inquiry without claiming the analysis was skipped', async perspective => {
    const input = turn(1);
    input.user.text = '看看我的阅读概况';
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) return '{"cards":[]}';
      const output = JSON.parse(completion(prompt));
      Object.assign(output.events[0], { eventType: 'exploration', state: 'exploring' });
      return JSON.stringify(output);
    });
    expect(await createInsightService().generate({ ...request, perspective }, deps)).toMatchObject({
      cards: [], emptyReason: 'no_supported_insights', modelCallCount: 2,
      coverage: { eligibleEventCount: 1, analysisPerformed: true }
    });
  });

  it.each([0, 14])('generates reverse-thinking hypotheses for the 21-turn inquiry case with %i rejected candidates', async omitted => {
    const inputs = Array.from({ length: 21 }, (_, index) => {
      const input = turn(index + 1);
      input.sessionId = `session-${index % 8}`;
      input.user.reference.sessionId = input.sessionId;
      input.assistants[0]!.reference.sessionId = input.sessionId;
      input.user.text = '有没有适合长期持有的债基';
      return input;
    });
    inputs[13]!.assistants[0]!.truncated = true; inputs[13]!.truncated = true;
    const deps = dependencies(inputs);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) {
        output.events = output.events.slice(0, 12).map((event: object) => ({ ...event, eventType: 'exploration', state: 'exploring' }));
        output.events.push(...Array.from({ length: omitted }, () => ({ invalid: true })));
      }
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) {
        output.cards[0] = { ...modelCard(output.cards[0].supportingEventIds),
          title: '长期持有是否足以降低风险', explanation: '假如持有期限与资金用途不匹配，较长持有期也可能无法避免被迫赎回。',
          scenarioEvidence: { eventId: output.cards[0].supportingEventIds[0], exactQuote: '长期持有的债基' } };
      }
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate(request, deps);
    expect(result).toMatchObject({ analyzedTurnCount: 21, analyzedSessionCount: 8,
      coverage: { userEventCount: 12, eligibleEventCount: 12, selectedEventCount: 12, analysisPerformed: true, omittedEventCount: omitted, truncatedAssistantMessageCount: 1 } });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.uncertainty).toContain('不能据此认定用户持有该观点');
    expect(result.cards[0]!.supportingReferences.every(ref => ref.role === 'user')).toBe(true);
    expect(result.emptyReason).toBeUndefined();
  });

  it('repairs then reports invalid output instead of treating rejected cards as a legitimate empty result', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') ? JSON.stringify({ cards: [
      modelCard(['forged-event']), modelCard(['v1'], 'source_fact'), { ...modelCard(), supportingReferences: [turn(1).user.reference] }
    ] }) : completion(prompt));
    await expect(createInsightService().generate(request, deps)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT', message: expect.stringContaining('证据校验') });
    expect(vi.mocked(deps.complete).mock.calls.filter(([prompt]) => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'))).toHaveLength(2);
  });

  it.each(['unknown', 'considering'] as const)('analyzes an explicit revised choice with %s state without assuming adoption', async state => {
    const input = turn(1);
    input.user.text = '把旧方案改为本地存储。';
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const output = JSON.parse(completion(prompt));
      if (prompt.includes('TASK: EXTRACT.')) Object.assign(output.events[0], { eventType: 'revision', state });
      return JSON.stringify(output);
    });
    const result = await createInsightService().generate({ ...request, perspective: 'second_order' }, deps);
    expect(result).toMatchObject({ truncated: false, modelCallCount: 2,
      coverage: { extractedEventCount: 1, userEventCount: 1, eligibleEventCount: 1, selectedEventCount: 1, analysisPerformed: true } });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.supportingReferences).toEqual([input.user.reference]);
    expect(result.cards[0]!.explanation).toContain('假如选择该方案');
  });

  it('can repair rejected cards while retaining program-mapped evidence', async () => {
    const deps = dependencies();
    let analyses = 0;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') && analyses++ === 0) return JSON.stringify({ cards: [modelCard(['forged-event'])] });
      return completion(prompt);
    });
    const result = await createInsightService().generate(request, deps);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.supportingReferences).toEqual([turn(2).user.reference]);
    expect(result.modelCallCount).toBe(3);
  });

  it('does not cache failed extraction batches, so regenerate can recover the missing turns', async () => {
    const service = createInsightService();
    const deps = dependencies(Array.from({ length: 31 }, (_, index) => turn(index + 1)));
    let failExtraction = true;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (failExtraction && prompt.includes('TASK: EXTRACT.')) {
        const marker = '\nUNTRUSTED_CONVERSATION_DATA_JSON\n';
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as { messages: { reference: MessageReference }[] }[];
        if (data.some(item => item.messages.some(message => message.reference.entryId === 'user-31'))) return completion(prompt);
        return '{"events":[{"invalid":"field"}]}';
      }
      return completion(prompt);
    });
    const partial = await service.generate(request, deps);
    expect(partial.analyzedTurnCount).toBe(1);
    expect(partial.omittedTurnCount).toBe(30);
    failExtraction = false;
    const recovered = await service.generate(request, deps);
    expect(recovered).toMatchObject({ semanticCacheHit: false, analyzedTurnCount: 31, omittedTurnCount: 0 });
    expect((await service.generate({ ...request, perspective: 'second_order' }, deps)).semanticCacheHit).toBe(true);
  });

  it('re-extracts partially validated events even when every turn was analyzed', async () => {
    const service = createInsightService();
    const deps = dependencies([turn(1)]);
    let invalidCandidate = true;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) return '{"cards":[]}';
      const output = JSON.parse(completion(prompt));
      if (invalidCandidate) output.events.push({ ...output.events[0], evidence: [{ evidenceId: 'forged-evidence', exactQuote: 'unverified' }] });
      return JSON.stringify(output);
    });
    expect(await service.generate(request, deps)).toMatchObject({ analyzedTurnCount: 1, omittedTurnCount: 0, cards: [], truncated: true, semanticCacheHit: false });
    expect(deps.onMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ extractedEventCount: 1, omittedEventCount: 1, eligibleEventCount: 1, cardCount: 0 }));
    invalidCandidate = false;
    expect(await service.generate(request, deps)).toMatchObject({ truncated: false, semanticCacheHit: false });
    expect(await service.generate({ ...request, perspective: 'second_order' }, deps)).toMatchObject({ semanticCacheHit: true });
  });

  it('reuses fingerprint-validated source limits instead of paying to repeat deterministic truncation', async () => {
    const input = turn(1); input.truncated = true;
    const service = createInsightService();
    const deps = dependencies([input]);
    await service.generate(request, deps);
    expect(await service.generate(request, deps)).toMatchObject({ analyzedTurnCount: 1, omittedTurnCount: 0, truncated: true, semanticCacheHit: true,
      coverage: { unknownSourceTruncation: true } });
    expect(extractCalls(deps)).toBe(1);
    expect(deps.onMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ sourceTruncated: true, omittedEventCount: 0 }));
  });

  it('reports perspective eligibility separately from extracted event count without logging history', async () => {
    const deps = dependencies([turn(1)]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      const marker = '\nUNTRUSTED_CONVERSATION_DATA_JSON\n';
      const [input] = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
      const assistant = input.messages.find((message: { reference: MessageReference }) => message.reference.role === 'assistant');
      return JSON.stringify({ events: [{ topicLabel: '本地方案', subjectLabel: '本地方案', dimensionLabel: '维护成本', eventType: 'option', speaker: 'assistant', state: 'considering',
        claim: assistant.text, evidence: [{ evidenceId: assistant.id, exactQuote: assistant.text }] }] });
    });
    expect(await createInsightService().generate(request, deps)).toMatchObject({ cards: [], truncated: false, modelCallCount: 1, emptyReason: 'no_eligible_events',
      coverage: { extractedEventCount: 1, eligibleEventCount: 0, selectedEventCount: 0, analysisPerformed: false } });
    expect(deps.onMetrics).toHaveBeenCalledWith(expect.objectContaining({ extractedEventCount: 1, eligibleEventCount: 0, selectedEventCount: 0, cardCount: 0 }));
    const metrics = vi.mocked(deps.onMetrics!).mock.calls[0]![0];
    expect(Object.values(metrics).every(value => typeof value === 'number' || typeof value === 'boolean' || value === request.perspective)).toBe(true);
  });

  it('distinguishes the 21-turn screenshot source limit from a failed or unperformed insight analysis', async () => {
    const turns = Array.from({ length: 21 }, (_, index) => {
      const input = turn(index + 1);
      input.sessionId = `session-${index % 8}`;
      input.user.reference.sessionId = input.sessionId;
      input.assistants[0]!.reference.sessionId = input.sessionId;
      input.user.text = '帮我查询今天的天气。';
      return input;
    });
    turns[13]!.assistants[0]!.truncated = true; turns[13]!.truncated = true;
    const deps = dependencies(turns);
    vi.mocked(deps.complete).mockResolvedValue('{"events":[]}');
    const service = createInsightService();
    const result = await service.generate(request, deps);
    expect(result).toMatchObject({ analyzedTurnCount: 21, analyzedSessionCount: 8, omittedTurnCount: 0, truncated: true,
      cards: [], emptyReason: 'no_eligible_events', coverage: { truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1,
        unknownSourceTruncation: false, eligibleEventCount: 0, analysisPerformed: false } });
    expect(await service.generate(request, deps)).toMatchObject({ semanticCacheHit: true, modelCallCount: 0, emptyReason: 'no_eligible_events' });
    expect(deps.complete).toHaveBeenCalledTimes(1);
  });

  it('accepts an analyzed empty answer despite unrelated assistant clipping', async () => {
    const input = turn(1); input.assistants[0]!.truncated = true; input.truncated = true;
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') ? '{"cards":[]}' : completion(prompt));
    expect(await createInsightService().generate(request, deps)).toMatchObject({ cards: [], truncated: true,
      emptyReason: 'no_supported_insights', coverage: { eligibleEventCount: 1, analysisPerformed: true, truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1 } });
  });

  it.each(['user', 'unknown', 'rejected_event'] as const)('does not claim complete negative findings after %s evidence loss', async kind => {
    const input = turn(1);
    if (kind === 'user') input.user.truncated = true;
    if (kind === 'unknown') input.truncated = true;
    const deps = dependencies([input]);
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) return '{"cards":[]}';
      const output = JSON.parse(completion(prompt));
      output.events[0].eventType = 'constraint'; output.events[0].state = 'unknown';
      if (kind === 'rejected_event') output.events.push({ invalid: true });
      return JSON.stringify(output);
    });
    expect(await createInsightService().generate(request, deps)).toMatchObject({ cards: [], truncated: true, emptyReason: 'incomplete_analysis' });
  });

  it('retries an invalid envelope once with a bounded output token budget', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') ? '{"cards":[],"shell":"echo secret"}' : completion(prompt));
    await expect(createInsightService().generate(request, deps)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    const attempts = vi.mocked(deps.complete).mock.calls.filter(([prompt]) => prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON'));
    expect(attempts).toHaveLength(2);
    expect(attempts.every(([, , tokens]) => tokens === 4096)).toBe(true);
    expect(attempts[1]![0]).not.toContain('echo secret');
  });

  it('sanitizes provider errors rather than exposing credentials or prompt text', async () => {
    const deps = dependencies();
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) throw Object.assign(new Error('secret api-key and private history'), { code: 'authentication' });
      return completion(prompt);
    });
    await expect(createInsightService().generate(request, deps)).rejects.toMatchObject({ code: 'MODEL_AUTHENTICATION', message: expect.not.stringContaining('secret') });
  });

  it('preserves sanitized adapter error codes and retries its empty response once', async () => {
    const deps = dependencies();
    let attempts = 0;
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON') && attempts++ === 0) throw new ConversationMapServiceError('MODEL_EMPTY_RESPONSE', '分析模型未返回有效内容。');
      return completion(prompt);
    });
    expect(await createInsightService().generate(request, deps)).toMatchObject({ modelCallCount: 3 });
    expect(attempts).toBe(2);
  });

  it('refuses a result if uncited history changes during generation, without caching it', async () => {
    const service = createInsightService();
    const deps = dependencies();
    vi.mocked(deps.historyFingerprint).mockReturnValueOnce('before').mockReturnValueOnce('after').mockReturnValue('before');
    await expect(service.generate(request, deps)).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
    expect(deps.onSourcesValidated).not.toHaveBeenCalled();
    const next = await service.generate(request, deps);
    expect(next.semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(2);
  });

  it('invalidates a cached snapshot after evidence authorization is revoked', async () => {
    const service = createInsightService();
    const deps = dependencies();
    await service.generate(request, deps);
    vi.mocked(deps.revalidateReferences).mockReturnValueOnce([]);
    await expect(service.generate(request, deps)).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
    expect((await service.generate(request, deps)).semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(2);
  });

  it('cancels a provider that ignores AbortSignal and never publishes/cache-writes a late response', async () => {
    const service = createInsightService();
    const deps = dependencies();
    const abort = new AbortController(); deps.signal = abort.signal;
    let resolve!: (value: string) => void;
    let announce!: () => void;
    const analyzing = new Promise<void>(done => { announce = done; });
    vi.mocked(deps.complete).mockImplementation(async prompt => {
      if (!prompt.includes('UNTRUSTED_INSIGHT_EVENTS_JSON')) return completion(prompt);
      announce(); return new Promise<string>(done => { resolve = done; });
    });
    const pending = service.generate(request, deps);
    await analyzing; abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    resolve(JSON.stringify({ cards: [modelCard()] }));
    await Promise.resolve();
    expect(deps.onSourcesValidated).not.toHaveBeenCalled();
    expect(deps.onMetrics).not.toHaveBeenCalled();
    deps.signal = new AbortController().signal;
    vi.mocked(deps.complete).mockImplementation(async prompt => completion(prompt));
    expect((await service.generate(request, deps)).semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(2);
  });

  it('expires cached snapshots and supports explicit worker invalidation', async () => {
    const service = createInsightService(new InsightSemanticCache());
    const deps = dependencies();
    await service.generate(request, deps);
    deps.now = () => new Date(now.getTime() + 16 * 60_000);
    expect((await service.generate(request, deps)).semanticCacheHit).toBe(false);
    service.clearCache();
    expect((await service.generate(request, deps)).semanticCacheHit).toBe(false);
    expect(extractCalls(deps)).toBe(3);
  });
});

describe('insight card semantics', () => {
  const evidence = turn(1).user;
  const event: EvolutionEvent = { id: 'v1', topicId: 't1', subjectKey: '方案', dimensionKey: '成本', eventType: 'option', speaker: 'user', state: 'considering', claim: evidence.text,
    occurredAt: evidence.reference.createdAt, evidence: [{ reference: evidence.reference, quote: evidence.text }], truncatedSource: false };
  it('marks an undecided option as a conditional path, never as an actual decision', () => {
    const output = validateInsightCards({ cards: [modelCard()] }, [event], 'second_order');
    expect(output.cards[0]!.explanation).toContain('假如选择该方案');
  });
  it('does not turn assistant suggestions into user decisions or evidence', () => {
    const assistant = { ...event, speaker: 'assistant' as const, evidence: [{ reference: { ...evidence.reference, role: 'assistant' as const }, quote: evidence.text }] };
    expect(validateInsightCards({ cards: [modelCard()] }, [assistant], 'second_order').cards).toEqual([]);
  });
  it.each(['exploration', 'open_question', 'position', 'constraint'] as const)('does not infer a second-order choice from a user %s without a plan', eventType => {
    const inquiry = { ...event, eventType, state: 'unknown' as const };
    expect(insightStrategy('second_order').selectEvents([inquiry])).toEqual(['exploration', 'open_question'].includes(eventType) ? [inquiry] : []);
    expect(validateInsightCards({ cards: [modelCard()] }, [inquiry], 'second_order').cards).toEqual([]);
  });
  it('accepts a concrete user event for blind spots without requiring multiple messages or AI evidence', () => {
    const sameSource = { ...event, id: 'v2' };
    const assistant = { ...event, id: 'v3', speaker: 'assistant' as const };
    expect(insightStrategy('blind_spots').selectEvents([event, sameSource, assistant])).toEqual([event, sameSource]);
  });
  it.each(['你好！', '谢谢。', '好的', '继续', '重试', 'OK'])('does not invent an analysis target from a trivial message: %s', quote => {
    const trivial = { ...event, eventType: 'exploration' as const, claim: quote, evidence: [{ reference: evidence.reference, quote }] };
    expect(insightStrategy('blind_spots').selectEvents([trivial])).toEqual([]);
  });
  it('rejects blind-spot cards that combine unrelated topics', () => {
    const unrelated = { ...event, id: 'v2', topicId: 't2' };
    expect(validateInsightCards({ cards: [modelCard(['v1', 'v2'], 'suggestion')] }, [event, unrelated], 'blind_spots')).toEqual({ cards: [], omittedCardCount: 1 });
  });
  it('uses uncertainty for inferred blind spots and explicitly limits truncated sources', () => {
    const output = validateInsightCards({ cards: [modelCard(['v1'], 'model_inference')] }, [{ ...event, truncatedSource: true }], 'blind_spots');
    expect(output.cards[0]!.explanation).toContain('可能');
    expect(output.cards[0]!.explanation).toContain('依据本次可核验的记录，仍值得补充确认');
    expect(output.cards[0]!.uncertainty).toContain('原文曾被截断');
  });
  it('rejects psychological labels and duplicate support IDs', () => {
    const cards = [{ ...modelCard(), title: '你是 INTJ' }, modelCard(['v1', 'v1'])];
    expect(validateInsightCards({ cards }, [event], 'second_order')).toEqual({ cards: [], omittedCardCount: 2 });
  });
  it.each(['该选择已经实现收益翻倍', '该方案确定导致成本下降', '该方案必然成功'])('drops asserted future outcomes: %s', explanation => {
    expect(validateInsightCards({ cards: [{ ...modelCard(), explanation }] }, [event], 'second_order').cards).toEqual([]);
  });
  it.each(['你从未考虑过维护成本', '你缺乏分析能力', '用户没有考虑利益相关方'])('does not turn missing chat evidence into a personal judgment: %s', explanation => {
    expect(validateInsightCards({ cards: [{ ...modelCard(['v1'], 'suggestion'), explanation }] }, [event], 'blind_spots').cards).toEqual([]);
  });
});
