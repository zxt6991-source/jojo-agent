import type { InsightEvent, InsightGenerateInput, InsightResult } from '@desktop-agent/contracts';
import type { AnalysisProgressHistory } from './analysis-progress';

export type InsightSelection = { range: InsightGenerateInput['range']; scopeKind: 'project' | 'personal_main' };
export const defaultInsightSelection: InsightSelection = { range: '30d', scopeKind: 'personal_main' };
export const perspectiveLabels = {
  conversation_map: '交流脉络', reverse_thinking: '逆向思考', second_order: '二阶思考', blind_spots: '思维盲点'
} as const;
export const natureLabels = { source_fact: '原文归纳', model_inference: 'AI 推测 · 可能', hypothesis: 'AI 提出的假设', suggestion: '验证建议' } as const;
export const localTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function insightSelectionKey(input: Omit<InsightGenerateInput, 'requestId'>): string {
  return JSON.stringify([input.perspective, input.range, input.scope.kind,
    input.scope.kind === 'project' ? input.scope.workingDirectory : '',
    input.scope.kind === 'project' ? input.currentSessionId ?? '' : '']);
}
export type InsightViewState = {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  request?: InsightGenerateInput;
  result?: { request: InsightGenerateInput; value: InsightResult };
  progress?: Extract<InsightEvent, { type: 'insight.progress' }>;
  progressHistory?: AnalysisProgressHistory;
  error?: string;
};
export type InsightViewAction = { type: 'start'; request: InsightGenerateInput } | { type: 'cancel' }
  | { type: 'invalidate' } | { type: 'event'; event: InsightEvent };
export function insightReducer(state: InsightViewState, action: InsightViewAction): InsightViewState {
  if (action.type === 'invalidate') return { status: 'idle' };
  const retained = state.result ? { result: state.result } : {};
  if (action.type === 'start') return {
    ...(state.result?.request.perspective === action.request.perspective ? retained : {}),
    status: 'running', request: action.request
  };
  if (action.type === 'cancel') return { ...retained, status: 'cancelled' };
  if (state.status !== 'running' || !state.request || action.event.requestId !== state.request.requestId) return state;
  switch (action.event.type) {
    case 'insight.progress': return { ...state, progress: action.event,
      progressHistory: { ...state.progressHistory, [action.event.phase]: action.event } };
    case 'insight.completed': return { status: 'completed', result: { request: state.request, value: action.event.result } };
    case 'insight.failed': return { ...retained, status: 'failed', error: action.event.message };
    case 'insight.cancelled': return { ...retained, status: 'cancelled' };
  }
}
