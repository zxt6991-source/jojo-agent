import type { ConversationMapEvent, ConversationMapGenerateInput, ConversationMapResult, ConversationStep, ConversationTopic, ConversationTopicV2, EvolutionEvent, EvolutionChange, QuoteEvidence, TopicInsight } from '@desktop-agent/contracts';

export const stepLabels: Record<ConversationStep['kind'], string> = {
  question: '用户提出', answer: 'AI 观点 / 建议', followup: '进一步追问', revision: '补充 / 修订'
};
export const relationLabels = { sequence: '时间先后', followup: '追问', revision: '修订', related: '相关讨论' } as const;

/** Display formatting only; evidence quotes are retained separately, verbatim. */
export function conversationPlainText(value: string): string {
  return value.replace(/<[^>]*>/gu, '')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/gu, '$1$2')
    .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/gu, '$1')
    .replace(/`+([^`]+)`+/gu, '$1')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function compactConversationText(value: string, limit: number): string {
  const characters = Array.from(conversationPlainText(value));
  return characters.length > limit ? `${characters.slice(0, Math.max(0, limit - 1)).join('')}…` : characters.join('');
}

export function eventReadingText(event: EvolutionEvent): string {
  return conversationPlainText(event.summary ?? event.claim);
}

export function eventReadingTitle(event: EvolutionEvent): string {
  const title = conversationPlainText(event.subjectLabel ?? '');
  // Internal grouping keys and repeated headings do not help readers understand a card.
  return !title || /^(?:交流内容|讨论内容|内容|主题)$/u.test(title) || eventReadingText(event).startsWith(title) ? '' : title;
}

/** Labels are data only: strip markup and encode every Mermaid grammar delimiter. */
export function mermaidLabel(value: string, maxLength = 160): string {
  const plain = conversationPlainText(value);
  const shortened = Array.from(plain).slice(0, maxLength).join('') || '未命名';
  return shortened.replace(/[&"'<>`\\[\]{}()#%;|]/gu, (character) => `#${character.codePointAt(0)};`);
}

export function orderedSteps(topic: ConversationTopic): ConversationStep[] {
  return [...topic.steps].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.references[0]!.seq - b.references[0]!.seq);
}

export function conversationMindmap(result: ConversationMapResult): string {
  const lines = ['mindmap', '  n0["交流脉络"]'];
  result.topics.forEach((topic, topicIndex) => {
    lines.push(`    t${topicIndex}["${mermaidLabel(topic.title, 80)}"]`);
    const summaries = 'events' in topic ? topic.insights.slice(0, 3).map(insight => insight.text) : topic.subtopics;
    summaries.forEach((text, index) => lines.push(`      t${topicIndex}s${index}["${mermaidLabel(text, 80)}"]`));
  });
  return lines.join('\n');
}

export function conversationFlowchart(topic: ConversationTopic): string {
  const steps = orderedSteps(topic);
  const ids = new Map(steps.map((step, index) => [step.id, `n${index}`]));
  const lines = ['flowchart TD'];
  steps.forEach((step, index) => lines.push(`  n${index}["${mermaidLabel(step.text)}"]:::${step.kind}`));
  for (const link of topic.links) {
    const from = ids.get(link.from); const to = ids.get(link.to);
    if (!from || !to || from === to) continue;
    lines.push(`  ${from} ${link.relation === 'related' ? '-.-' : '-->'}|${relationLabels[link.relation]}| ${to}`);
  }
  lines.push('  classDef question fill:#eef2ff,stroke:#6374c8,color:#26335d', '  classDef answer fill:#f0f8f4,stroke:#64967d,color:#254632', '  classDef followup fill:#fff8eb,stroke:#bca06b,color:#574626', '  classDef revision fill:#f8f0fa,stroke:#9f80b3,color:#533663');
  return lines.join('\n');
}

export const eventLabels: Record<EvolutionEvent['eventType'], string> = {
  exploration: '探索', position: '观点', constraint: '新约束', option: '方案', decision: '决定', revision: '修订', action: '执行反馈', open_question: '待解决'
};
export const stateLabels: Record<EvolutionEvent['state'], string> = {
  exploring: '探索中', considering: '考虑中', planned: '计划中', decided: '已决定', reported_done: '用户报告已完成', rejected: '已否定', unknown: '尚未确认'
};
export const changeLabels: Record<EvolutionChange['relation'], string> = { continued: '延续', refined: '细化', revised: '修订', rejected: '否定' };

export function orderedEvents(topic: ConversationTopicV2, all = false): EvolutionEvent[] {
  const visible = new Set(topic.visibleEventIds);
  return topic.events.filter(event => all || visible.has(event.id)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || a.evidence[0]!.reference.seq - b.evidence[0]!.reference.seq || a.id.localeCompare(b.id));
}

/** An insight carries no new evidence: resolve its event/change dependencies, including both endpoints. */
export function insightEvidence(topic: ConversationTopicV2, insight: TopicInsight): QuoteEvidence[] {
  const changes = topic.changes.filter(change => insight.supportingChangeIds.includes(change.id));
  const eventIds = new Set([...insight.supportingEventIds, ...changes.flatMap(change => [change.fromEventId, change.toEventId])]);
  const evidence = [...orderedEvents(topic, true).filter(event => eventIds.has(event.id)).flatMap(event => event.evidence), ...changes.flatMap(change => change.reasonEvidence ?? [])];
  return [...new Map(evidence.map(item => [JSON.stringify([item.reference.sessionId, item.reference.entryId, item.quote]), item])).values()];
}

export function evolutionFlowchart(topic: ConversationTopicV2): string {
  const events = orderedEvents(topic);
  const ids = new Map(events.map((event, index) => [event.id, `n${index}`]));
  const lines = ['flowchart TD'];
  events.forEach((event, index) => {
    const body = Array.from(compactConversationText(eventReadingText(event), 120));
    const bodyLines: string[] = [];
    for (let offset = 0; offset < body.length; offset += 18) bodyLines.push(body.slice(offset, offset + 18).join(''));
    const title = eventReadingTitle(event);
    const parts = [...(title ? [compactConversationText(title, 26)] : []), ...bodyLines];
    // Only these fixed line breaks are markup; every data segment is escaped independently.
    lines.push(`  n${index}["${parts.map(part => mermaidLabel(part)).join('<br/>')}"]:::${event.eventType}`);
  });
  for (let index = 1; index < events.length; index++) {
    const from = events[index - 1]!; const to = events[index]!;
    if (!topic.changes.some(change => change.fromEventId === from.id && change.toEventId === to.id)) lines.push(`  n${index - 1} -.-> n${index}`);
  }
  for (const change of topic.changes) {
    const from = ids.get(change.fromEventId); const to = ids.get(change.toEventId);
    if (!from || !to || from === to) continue;
    lines.push(`  ${from} -->|${changeLabels[change.relation]}| ${to}`);
  }
  lines.push('  classDef decision,revision fill:#f8f0fa,stroke:#9f80b3,color:#533663', '  classDef constraint,position fill:#eef2ff,stroke:#6374c8,color:#26335d', '  classDef option,exploration fill:#f0f8f4,stroke:#64967d,color:#254632', '  classDef action,open_question fill:#fff8eb,stroke:#bca06b,color:#574626');
  return lines.join('\n');
}

export function conversationMapSelectionKey(input: Pick<ConversationMapGenerateInput, 'range' | 'scope'>): string {
  return JSON.stringify([input.range, input.scope.kind, input.scope.kind === 'project' ? input.scope.workingDirectory : '']);
}

export type ConversationMapViewState = {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  activeRequestId?: string;
  request?: ConversationMapGenerateInput;
  result?: { request: ConversationMapGenerateInput; value: ConversationMapResult };
  progress?: Extract<ConversationMapEvent, { type: 'conversation-map.progress' }>;
  error?: string;
  errorCode?: string;
};
export type ConversationMapViewAction =
  | { type: 'start'; request: ConversationMapGenerateInput }
  | { type: 'cancel' }
  | { type: 'invalidate' }
  | { type: 'event'; event: ConversationMapEvent };

/** Ignore late events, including completion after cancellation or a replacement request. */
export function conversationMapReducer(state: ConversationMapViewState, action: ConversationMapViewAction): ConversationMapViewState {
  if (action.type === 'invalidate') return { status: 'idle' };
  const retained = state.result ? { result: state.result } : {};
  if (action.type === 'start') return { ...retained, status: 'running', activeRequestId: action.request.requestId, request: action.request };
  if (action.type === 'cancel') return { ...retained, status: 'cancelled' };
  const event = action.event;
  if (event.requestId !== state.activeRequestId || !state.request || state.status !== 'running') return state;
  switch (event.type) {
    case 'conversation-map.progress': return { ...state, progress: event };
    case 'conversation-map.completed': return { status: 'completed', result: { request: state.request, value: event.result } };
    case 'conversation-map.failed': return { ...retained, status: 'failed', error: event.message, errorCode: event.code };
    case 'conversation-map.cancelled': return { ...retained, status: 'cancelled' };
  }
}
