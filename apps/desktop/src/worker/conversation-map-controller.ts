import {
  sessionHasProject, type ConversationMapGenerateInput, type ConversationMapEvent,
  type ConversationMapResult, type ConversationMapScope, type ConversationMapSourceInput, type ConversationMapSourceResult,
  type SessionMeta, type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import { createProjectIdentity } from '@desktop-agent/memory';

export interface ConversationMapAuthorization {
  allowedSessionIds: string[];
  projectDirectory?: string;
  scope: ConversationMapScope;
}

export function createConversationMapController(deps: {
  listSessions(): Promise<SessionMeta[]>;
  generate(input: ConversationMapGenerateInput, context: {
    signal: AbortSignal;
    authorize(): Promise<ConversationMapAuthorization>;
    onProgress(event: Extract<ConversationMapEvent, { type: 'conversation-map.progress' }>): void;
  }): Promise<ConversationMapResult>;
  readSource(input: ConversationMapSourceInput, auth: ConversationMapAuthorization): Promise<ConversationMapSourceResult>;
  post(message: WorkerMessage): void;
}) {
  let active: { id: string; abort: AbortController } | undefined;
  let completed: { input: ConversationMapGenerateInput; result: ConversationMapResult } | undefined;

  async function authorize(input: ConversationMapGenerateInput): Promise<ConversationMapAuthorization> {
    const sessions = await deps.listSessions();
    if (input.scope.kind === 'personal_main') return { allowedSessionIds: sessions.map(s => s.id), scope: input.scope };
    const selected = sessions.find(s => s.id === input.currentSessionId);
    if (!selected || !sessionHasProject(selected)) throw new Error('当前项目已不可用，请重新选择范围。');
    const [identity, requested] = await Promise.all([
      createProjectIdentity(selected.workingDirectory), createProjectIdentity(input.scope.workingDirectory)
    ]);
    if (!identity || identity.id !== requested?.id) throw new Error('项目范围与当前对话不匹配。');
    const matching = await Promise.all(sessions.map(async session => {
      if (!sessionHasProject(session)) return undefined;
      const candidate = await createProjectIdentity(session.workingDirectory);
      return candidate?.id === identity.id ? session.id : undefined;
    }));
    return { allowedSessionIds: matching.filter((id): id is string => !!id), projectDirectory: identity.canonicalPath, scope: { kind: 'project', workingDirectory: identity.canonicalPath } };
  }

  function cancel(requestId?: string) {
    if (active && (!requestId || active.id === requestId)) {
      const previous = active; active = undefined;
      previous.abort.abort();
      deps.post({ type: 'conversation-map.event', event: { type: 'conversation-map.cancelled', requestId: previous.id } });
    }
    if (!requestId || completed?.input.requestId === requestId) completed = undefined;
  }

  async function generate(input: ConversationMapGenerateInput) {
    if (active) {
      if (active.id !== input.requestId) deps.post({ type: 'conversation-map.event', event: {
        type: 'conversation-map.failed', requestId: input.requestId, code: 'busy', message: '已有生成任务，请先取消。'
      } });
      return;
    }
    const task = { id: input.requestId, abort: new AbortController() };
    active = task; completed = undefined;
    try {
      await authorize(input);
      task.abort.signal.throwIfAborted();
      const result = await deps.generate(input, {
        signal: task.abort.signal, authorize: () => authorize(input),
        onProgress: event => { if (active === task && !task.abort.signal.aborted) deps.post({ type: 'conversation-map.event', event }); }
      });
      task.abort.signal.throwIfAborted();
      if (active !== task) return;
      // Recheck scope after the final model call; no revoked session may survive.
      const auth = await authorize(input);
      if (result.topics.some(topic => topic.steps.some(step => step.references.some(ref => !auth.allowedSessionIds.includes(ref.sessionId))))) {
        throw new Error('原始记录或项目范围已变化，请重新生成。');
      }
      task.abort.signal.throwIfAborted();
      completed = { input, result };
      deps.post({ type: 'conversation-map.event', event: { type: 'conversation-map.completed', requestId: input.requestId, result } });
    } catch (error) {
      if (active === task && !task.abort.signal.aborted) deps.post({ type: 'conversation-map.event', event: {
        type: 'conversation-map.failed', requestId: input.requestId,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code).slice(0, 128) : 'generation_failed',
        message: error instanceof Error && error.message === 'conversation_map_scope_too_large'
          ? '可访问会话超过 1000 个，请选择当前项目缩小范围。'
          : error instanceof Error ? error.message.slice(0, 1000) : '生成失败，请重试。'
      } });
    } finally { if (active === task) active = undefined; }
  }

  async function source(input: ConversationMapSourceInput): Promise<ConversationMapSourceResult> {
    const snapshot = completed;
    if (!snapshot || snapshot.input.requestId !== input.requestId) return { available: false };
    const ref = snapshot.result.topics.flatMap(t => t.steps).flatMap(s => s.references)
      .find(r => r.sessionId === input.sessionId && r.entryId === input.entryId);
    if (!ref) return { available: false };
    const auth = await authorize(snapshot.input);
    if (!auth.allowedSessionIds.includes(input.sessionId) || completed !== snapshot) return { available: false };
    const result = await deps.readSource(input, auth);
    return completed === snapshot ? result : { available: false };
  }

  return {
    cancel,
    handle(command: WorkerCommand): boolean {
      if (command.type === 'conversation-map.generate') { void generate(command.input); return true; }
      if (command.type === 'conversation-map.cancel') { cancel(command.requestId); return true; }
      if (command.type === 'conversation-map.source') {
        void source(command.input).catch((): ConversationMapSourceResult => ({ available: false }))
          .then(result => deps.post({ type: 'conversation-map.source.result', requestId: command.requestId, result }));
        return true;
      }
      return false;
    }
  };
}
