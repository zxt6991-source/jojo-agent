import type { ConversationMapEvent, InsightEvent, InsightPerspective } from '@desktop-agent/contracts';

export type AnalysisProgress = Extract<InsightEvent | ConversationMapEvent, { type: 'insight.progress' | 'conversation-map.progress' }>;
export type AnalysisPhase = AnalysisProgress['phase'];
export type AnalysisProgressHistory = Partial<Record<AnalysisPhase, AnalysisProgress>>;

const sharedSteps = [
  { phase: 'reading', label: '读取历史', description: '读取所选时间和数据范围内的对话，准备分析材料。' },
  { phase: 'extracting', label: '提取关键内容', description: '分批梳理对话中的问题、观点、约束和方案，并保留原文依据。' },
  { phase: 'merging', label: '归并讨论主题', description: '把相关讨论归到同一主题，连接分散在不同对话中的线索。' }
] as const;
const perspectiveSteps = {
  reverse_thinking: { phase: 'analyzing', label: '检验假设与反例', description: '围绕已有观点检验假设，寻找反例与可能的失败条件。' },
  second_order: { phase: 'analyzing', label: '推演后续影响', description: '从方案或选择出发，分析直接影响之后可能出现的连锁变化。' },
  blind_spots: { phase: 'analyzing', label: '寻找信息缺口', description: '检查所选讨论中的信息缺口和未验证前提，整理值得补充的问题。' }
} as const;

export function analysisSteps(perspective: InsightPerspective): { phase: AnalysisPhase; label: string; description: string }[] {
  return [...sharedSteps, ...(perspective === 'conversation_map' ? [
    { phase: 'comparing' as const, label: '比较观点变化', description: '按主题对照不同时点的观点，识别延续、调整和仍待解决的问题。' },
    { phase: 'rendering' as const, label: '核对依据与绘图', description: '检查摘要和原文是否一致，整理有依据的交流脉络。' }
  ] : [perspectiveSteps[perspective],
    { phase: 'validating' as const, label: '核对原文依据', description: '核对洞察引用与原文，确认分析范围和来源仍然有效。' }
  ])];
}

export function analysisStepStatus(phase: AnalysisPhase, current: AnalysisPhase, history: AnalysisProgressHistory, steps: ReturnType<typeof analysisSteps>) {
  if (phase === current) return 'active';
  if (history[phase]) return 'done';
  return steps.findIndex(step => step.phase === phase) < steps.findIndex(step => step.phase === current) ? 'skipped' : 'pending';
}

/** Counts describe only the current unit of work, never an estimated overall percentage. */
export function analysisCount(progress: AnalysisProgress | undefined): string {
  if (!progress || progress.completed === undefined) return '';
  // One opaque synthesis call has no measurable intermediate work units.
  if (progress.phase === 'analyzing') return '';
  const unit = progress.phase === 'reading' ? '轮对话' : progress.phase === 'extracting' || progress.phase === 'rendering' ? '批' : progress.phase === 'comparing' ? '个主题' : '';
  if (progress.total !== undefined && progress.total > 0) return `${progress.completed} / ${progress.total}${unit ? ` ${unit}` : ''}`;
  return progress.phase === 'reading' && progress.completed > 0 ? `已读取 ${progress.completed} 轮对话` : '';
}

export function analysisDuration(seconds: number): string {
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
