import { createHash } from 'node:crypto';
import {
  InsightResultSchema, type InsightEvent, type InsightGenerateInput, type InsightResult,
  type InsightSourceInput, type InsightSourceResult, type MessageReference, type SessionMeta,
  type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import { authorizeHistoryAnalysis, type HistoryAnalysisAuthorization } from '../history-analysis-authorization';
import type { HistoryAnalysisTaskGate } from '../history-analysis-task';

type Source = { reference: MessageReference; text: string };
type History = Pick<InsightResult, 'rangeStart' | 'rangeEnd'> & { fingerprint: string };
export interface InsightGenerationContext {
  signal: AbortSignal;
  authorize(): Promise<HistoryAnalysisAuthorization>;
  onProgress(event: Extract<InsightEvent, { type: 'insight.progress' }>): void;
  onSourcesValidated(sources: Source[]): void;
  onHistoryValidated(history: History): void;
}
const sourceKey = (reference: Pick<MessageReference, 'sessionId' | 'entryId'>) => JSON.stringify([reference.sessionId, reference.entryId]);
const digest = (source: Source) => createHash('sha256').update(JSON.stringify([source.reference, source.text])).digest('hex');

export function createInsightController(deps: {
  listSessions(): Promise<SessionMeta[]>;
  taskGate: HistoryAnalysisTaskGate;
  generate(input: InsightGenerateInput, context: InsightGenerationContext): Promise<InsightResult>;
  readSource(input: InsightSourceInput, auth: HistoryAnalysisAuthorization): Promise<InsightSourceResult>;
  historyFingerprint(history: Pick<InsightResult, 'rangeStart' | 'rangeEnd'>, auth: HistoryAnalysisAuthorization): Promise<string>;
  post(message: WorkerMessage): void;
}) {
  let active: { id: string; abort: AbortController; release(): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let completed: { input: InsightGenerateInput; result: InsightResult; sources: Map<string, string>; history: History } | undefined;
  const authorize = (input: InsightGenerateInput) => authorizeHistoryAnalysis(input, deps.listSessions);
  const emit = (event: InsightEvent) => deps.post({ type: 'insight.event', event });

  function cancel(requestId?: string) {
    if (active && (!requestId || active.id === requestId)) {
      const previous = active; active = undefined;
      clearTimeout(previous.timer); previous.abort.abort(); previous.release();
      emit({ type: 'insight.cancelled', requestId: previous.id });
    }
    if (!requestId || completed?.input.requestId === requestId) completed = undefined;
  }

  async function generate(input: InsightGenerateInput) {
    if (active?.id === input.requestId) return;
    const release = active ? undefined : deps.taskGate.acquire();
    if (!release) { emit({ type: 'insight.failed', requestId: input.requestId, code: 'busy', message: '已有洞察分析任务，请先取消。' }); return; }
    const task = { id: input.requestId, abort: new AbortController(), release,
      timer: setTimeout(() => {
        if (active !== task) return;
        active = undefined; task.abort.abort(); task.release();
        emit({ type: 'insight.failed', requestId: input.requestId, code: 'timeout', message: '分析超时，请缩小范围后重试。' });
      }, 10 * 60_000) };
    active = task; completed = undefined;
    const sources = new Map<string, string>();
    let history: History | undefined;
    try {
      await authorize(input);
      task.abort.signal.throwIfAborted();
      const result = InsightResultSchema.parse(await deps.generate(input, {
        signal: task.abort.signal, authorize: () => authorize(input),
        onProgress: event => { if (active === task && !task.abort.signal.aborted) emit(event); },
        onSourcesValidated: values => {
          if (active !== task || task.abort.signal.aborted) return;
          sources.clear(); values.forEach(value => sources.set(sourceKey(value.reference), digest(value)));
        },
        onHistoryValidated: value => { if (active === task && !task.abort.signal.aborted) history = value; }
      }));
      task.abort.signal.throwIfAborted();
      if (active !== task) return;
      const auth = await authorize(input);
      if (result.perspective !== input.perspective || result.scopeKind !== auth.scope.kind
        || !history || history.rangeStart !== result.rangeStart || history.rangeEnd !== result.rangeEnd
        || result.cards.flatMap(card => card.supportingReferences).some(ref => !auth.allowedSessionIds.includes(ref.sessionId) || !sources.has(sourceKey(ref)))
        || await deps.historyFingerprint(result, auth) !== history.fingerprint) {
        throw new Error('原始记录或项目范围已变化，请重新生成。');
      }
      task.abort.signal.throwIfAborted();
      if (active !== task) return;
      completed = { input, result, sources, history };
      emit({ type: 'insight.completed', requestId: input.requestId, result });
    } catch (error) {
      if (active === task && !task.abort.signal.aborted) emit({ type: 'insight.failed', requestId: input.requestId,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code).slice(0, 128) : 'generation_failed',
        message: error instanceof Error && error.message === 'conversation_map_scope_too_large'
          ? '可访问会话超过 1000 个，请选择当前项目缩小范围。'
          : error instanceof Error && error.message === 'insight_history_too_large'
            ? '所选历史内容超过分析上限，请缩小时间或项目范围。'
            : error instanceof Error ? error.message.slice(0, 1000) : '生成失败，请重试。' });
    } finally { clearTimeout(task.timer); task.release(); if (active === task) active = undefined; }
  }

  async function source(input: InsightSourceInput): Promise<InsightSourceResult> {
    const snapshot = completed;
    if (!snapshot || snapshot.input.requestId !== input.requestId) return { available: false };
    const reference = snapshot.result.cards.flatMap(card => card.supportingReferences)
      .find(ref => sourceKey(ref) === sourceKey(input));
    if (!reference) return { available: false };
    try {
      const auth = await authorize(snapshot.input);
      if (!auth.allowedSessionIds.includes(input.sessionId)
        || await deps.historyFingerprint(snapshot.result, auth) !== snapshot.history.fingerprint) {
        if (completed === snapshot) completed = undefined;
        return { available: false };
      }
      if (completed !== snapshot) return { available: false };
      const result = await deps.readSource(input, auth);
      if (completed !== snapshot) return { available: false };
      if (!result.available || digest(result) !== snapshot.sources.get(sourceKey(reference))) {
        completed = undefined; return { available: false };
      }
      return result;
    } catch {
      if (completed === snapshot) completed = undefined;
      return { available: false };
    }
  }

  return { cancel, handle(command: WorkerCommand): boolean {
    if (command.type === 'insight.generate') { void generate(command.input); return true; }
    if (command.type === 'insight.cancel') { cancel(command.requestId); return true; }
    if (command.type === 'insight.source') {
      void source(command.input).then(result => deps.post({ type: 'insight.source.result', requestId: command.requestId, result }));
      return true;
    }
    return false;
  } };
}
