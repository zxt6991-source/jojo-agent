import type { WorkerMessage } from '@desktop-agent/contracts';

/** Bounded, process-local operational counts. Never records source text or prompts. */
export function createHistoryAnalysisMetrics(report: (value: Record<string, string | number | boolean>) => void) {
  const progress = new Map<string, { phase: string; readTurnCount: number }>();
  const totals = { completed: 0, failed: 0, cancelled: 0 };
  return (message: WorkerMessage) => {
    if (message.type !== 'insight.event' && message.type !== 'conversation-map.event') return;
    const event = message.event;
    if ('phase' in event) {
      // Normally only one task is active. Bound this even for malformed producers.
      if (!progress.has(event.requestId) && progress.size >= 4) progress.delete(progress.keys().next().value!);
      const previous = progress.get(event.requestId);
      progress.set(event.requestId, { phase: event.phase,
        readTurnCount: event.phase === 'reading' ? event.completed ?? 0 : previous?.readTurnCount ?? 0 });
      return;
    }
    const previous = progress.get(event.requestId);
    progress.delete(event.requestId);
    const status = 'result' in event ? 'completed' : 'code' in event ? 'failed' : 'cancelled';
    totals[status]++;
    const result = 'result' in event ? event.result : undefined;
    report({ kind: message.type === 'insight.event' ? 'insight' : 'conversation_map', status,
      phase: previous?.phase ?? 'authorization', readTurnCount: result?.analyzedTurnCount ?? previous?.readTurnCount ?? 0,
      ...totals });
  };
}
