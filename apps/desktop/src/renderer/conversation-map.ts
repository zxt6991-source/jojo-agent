import type { ConversationMapEvent, ConversationMapGenerateInput, ConversationMapResult, ConversationStep, ConversationTopic } from '@desktop-agent/contracts';

export const stepLabels: Record<ConversationStep['kind'], string> = {
  question: '用户提出', answer: 'AI 观点 / 建议', followup: '进一步追问', revision: '补充 / 修订'
};
export const relationLabels = { sequence: '时间先后', followup: '追问', revision: '修订', related: '相关讨论' } as const;

/** Labels are data only: strip markup and encode every Mermaid grammar delimiter. */
export function mermaidLabel(value: string, maxLength = 160): string {
  const plain = value.replace(/<[^>]*>/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
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
    topic.subtopics.forEach((text, index) => lines.push(`      t${topicIndex}s${index}["${mermaidLabel(text, 80)}"]`));
  });
  return lines.join('\n');
}

export function conversationFlowchart(topic: ConversationTopic): string {
  const steps = orderedSteps(topic);
  const ids = new Map(steps.map((step, index) => [step.id, `n${index}`]));
  const lines = ['flowchart TD'];
  steps.forEach((step, index) => lines.push(`  n${index}["${mermaidLabel(`${stepLabels[step.kind]}：${step.text}`)}"]:::${step.kind}`));
  for (const link of topic.links) {
    const from = ids.get(link.from); const to = ids.get(link.to);
    if (!from || !to || from === to) continue;
    lines.push(`  ${from} ${link.relation === 'related' ? '-.-' : '-->'}|${relationLabels[link.relation]}| ${to}`);
  }
  lines.push('  classDef question fill:#eef2ff,stroke:#6374c8,color:#26335d', '  classDef answer fill:#f0f8f4,stroke:#64967d,color:#254632', '  classDef followup fill:#fff8eb,stroke:#bca06b,color:#574626', '  classDef revision fill:#f8f0fa,stroke:#9f80b3,color:#533663');
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
