import type {
  AgentEvent,
  HookContext,
  HookEventName,
  HookHandlerResult,
  HookInjectionResult,
  HookInvocationRecord,
  HookInvocationStore,
  HookLogger,
  HookPayloadMap,
  HookRuntime,
  InjectingHookEvent,
  PreToolUseHookResult,
  PreToolUsePayload,
  SideEffectHookEvent
} from '@desktop-agent/contracts';
import { hookError } from './errors.js';
import { MemoryHookInvocationStore } from './invocation-store.js';
import { hookMatches } from './matcher.js';
import { HookRegistry, type RegisteredHook } from './registry.js';

const nullLogger: HookLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
const MAX_CONTEXT_PER_HOOK = 16 * 1024;
const MAX_CONTEXT_PER_EVENT = 32 * 1024;

function boundedUtf8(text: string, maximumBytes: number): string {
  const encoded = Buffer.from(text);
  return encoded.length <= maximumBytes ? text : encoded.subarray(0, maximumBytes).toString('utf8');
}

export type DefaultHookRuntimeOptions = {
  invocationStore?: HookInvocationStore;
  logger?: HookLogger;
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  recoveryLeaseMs?: number;
};

function subjectId(event: HookEventName, payload: HookPayloadMap[HookEventName]): string {
  if (event === 'PreToolUse' || event === 'PostToolUse') return (payload as PreToolUsePayload).toolCallId;
  if (event === 'SubagentStop') return (payload as HookPayloadMap['SubagentStop']).subagentId;
  if (event === 'Stop') return 'operation';
  if (event === 'SessionStart') return 'session';
  if (event === 'PreCompact') return payload.eventId;
  return 'prompt';
}

function invocationId(payload: HookPayloadMap[HookEventName], hook: { id: string }): string {
  return `${payload.operationId}:${payload.event}:${subjectId(payload.event, payload)}:${hook.id}`;
}

export class DefaultHookRuntime implements HookRuntime {
  private readonly store: HookInvocationStore;
  private readonly logger: HookLogger;
  private readonly emit: ((event: AgentEvent) => void) | undefined;
  private readonly signal: AbortSignal;
  private readonly recoveryLeaseMs: number;

  constructor(readonly registry: HookRegistry, options: DefaultHookRuntimeOptions = {}) {
    this.store = options.invocationStore ?? new MemoryHookInvocationStore();
    this.logger = options.logger ?? nullLogger;
    this.emit = options.emit;
    this.signal = options.signal ?? new AbortController().signal;
    this.recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
  }

  configured(event: HookEventName): boolean { return this.registry.configured(event); }

  private context(payload: HookPayloadMap[HookEventName], signal: AbortSignal): HookContext {
    return {
      sessionId: payload.sessionId,
      operationId: payload.operationId,
      lane: payload.lane,
      workingDirectory: payload.workingDirectory,
      providerId: payload.provider.id,
      model: payload.provider.model,
      signal,
      agent: payload.agent,
      logger: this.logger
    };
  }

  private async invoke<E extends HookEventName>(
    hook: RegisteredHook<E>,
    payload: HookPayloadMap[E],
    signal: AbortSignal = this.signal
  ): Promise<HookHandlerResult<E> | undefined> {
    const id = invocationId(payload, hook);
    const existing = await this.store.getInvocation(id);
    if (existing?.state === 'completed') return structuredClone(existing.result) as HookHandlerResult<E>;
    if (existing?.state === 'failed') {
      if (hook.onError === 'block' && payload.event === 'PreToolUse') {
        return {
          decision: 'block',
          reason: `Hook ${hook.id} failed: ${existing.error?.message ?? 'unknown error'}`
        } as HookHandlerResult<E>;
      }
      return undefined;
    }

    const recoverRunningSideEffect = existing?.state === 'running'
      && (payload.event === 'Stop' || payload.event === 'SubagentStop' || payload.event === 'PreCompact');
    const record: HookInvocationRecord = {
      id,
      eventId: payload.eventId,
      hookId: hook.id,
      event: payload.event,
      sessionId: payload.sessionId,
      operationId: payload.operationId,
      subjectId: subjectId(payload.event, payload),
      state: 'pending',
      payload
    };
    if (!recoverRunningSideEffect && await this.store.beginInvocation(record) === 'exists') {
      const raced = await this.store.getInvocation(id);
      if (raced?.state === 'completed') return structuredClone(raced.result) as HookHandlerResult<E>;
      if (hook.onError === 'block' && payload.event === 'PreToolUse') {
        return { decision: 'block', reason: `Hook ${hook.id} is incomplete.` } as HookHandlerResult<E>;
      }
      return undefined;
    }

    const started = Date.now();
    this.emit?.({ type: 'hook.started', eventId: payload.eventId, hookId: hook.id, hookEvent: payload.event });
    try {
      const result = await hook.handler(payload, this.context(payload, signal));
      await this.store.completeInvocation(id, result ?? null);
      const outcome = payload.event === 'PreToolUse'
        ? ((result as PreToolUseHookResult | undefined)?.decision ?? 'neutral')
        : payload.event === 'SessionStart' || payload.event === 'UserPromptSubmit' || payload.event === 'PostToolUse'
          ? ((result as HookInjectionResult | undefined)?.additionalContext ? 'injected' : 'neutral')
          : 'side_effect';
      this.emit?.({ type: 'hook.finished', eventId: payload.eventId, hookId: hook.id, durationMs: Date.now() - started, outcome });
      return result;
    } catch (error) {
      const failure = hookError(error);
      await this.store.failInvocation(id, { code: failure.code, message: failure.message });
      this.logger.warn(`Hook ${hook.id} failed.`, failure);
      this.emit?.({ type: 'hook.failed', eventId: payload.eventId, hookId: hook.id, code: failure.code, message: failure.message });
      if (hook.onError === 'block' && payload.event === 'PreToolUse') {
        return { decision: 'block', reason: `Hook ${hook.id} failed: ${failure.message}` } as HookHandlerResult<E>;
      }
      return undefined;
    }
  }

  private async deferSideEffect<E extends SideEffectHookEvent>(
    hook: RegisteredHook<E>,
    payload: HookPayloadMap[E]
  ): Promise<void> {
    const id = invocationId(payload, hook);
    const existing = await this.store.getInvocation(id);
    if (existing) return;
    const record: HookInvocationRecord = {
      id,
      eventId: payload.eventId,
      hookId: hook.id,
      event: payload.event,
      sessionId: payload.sessionId,
      operationId: payload.operationId,
      subjectId: subjectId(payload.event, payload),
      state: 'pending',
      payload
    };
    if (await this.store.beginInvocation(record) === 'exists') return;
    const started = Date.now();
    this.emit?.({ type: 'hook.started', eventId: payload.eventId, hookId: hook.id, hookEvent: payload.event });
    const signal = new AbortController().signal;
    void Promise.resolve().then(() => hook.handler(payload, this.context(payload, signal))).then(async (result) => {
      await this.store.completeInvocation(id, result ?? null);
      this.emit?.({
        type: 'hook.finished', eventId: payload.eventId, hookId: hook.id,
        durationMs: Date.now() - started, outcome: 'side_effect'
      });
    }).catch(async (error: unknown) => {
      const failure = hookError(error);
      try { await this.store.failInvocation(id, { code: failure.code, message: failure.message }); }
      catch { /* Preserve the hook failure as the primary diagnostic. */ }
      this.logger.warn(`Hook ${hook.id} failed.`, failure);
      this.emit?.({ type: 'hook.failed', eventId: payload.eventId, hookId: hook.id, code: failure.code, message: failure.message });
    });
  }

  async recoverPendingSideEffects(): Promise<void> {
    const records = await this.store.listIncomplete?.() ?? [];
    for (const record of records) {
      if (record.event !== 'Stop' && record.event !== 'SubagentStop' && record.event !== 'PreCompact') continue;
      if (record.state === 'running' && (record.startedAt ?? 0) + this.recoveryLeaseMs > Date.now()) continue;
      if (!record.payload) continue;
      const hook = this.registry.snapshot(record.event).find((candidate) => candidate.id === record.hookId);
      if (!hook) continue;
      await this.invoke(hook, record.payload as HookPayloadMap[typeof record.event]);
    }
  }

  async inject<E extends InjectingHookEvent>(
    event: E,
    payload: HookPayloadMap[E]
  ): Promise<HookInjectionResult> {
    const chunks: string[] = [];
    const hookIds: string[] = [];
    let size = 0;
    for (const hook of this.registry.snapshot(event)) {
      if (!hookMatches(hook.matcher, event, payload)) continue;
      const result = await this.invoke(hook, payload) as HookInjectionResult | undefined;
      const text = result?.additionalContext?.trim();
      if (!text) continue;
      const bounded = boundedUtf8(text, MAX_CONTEXT_PER_HOOK);
      const remaining = MAX_CONTEXT_PER_EVENT - size;
      if (remaining <= 0) break;
      const chunk = boundedUtf8(bounded, remaining);
      chunks.push(chunk);
      hookIds.push(hook.id);
      size += Buffer.byteLength(chunk);
    }
    return { additionalContext: chunks.join('\n\n'), ...(hookIds.length ? { hookIds } : {}) };
  }

  async preToolUse(payload: PreToolUsePayload): Promise<PreToolUseHookResult> {
    let approval: Extract<PreToolUseHookResult, { decision: 'approve' }> | undefined;
    let canSkipApproval = false;
    for (const hook of this.registry.snapshot('PreToolUse')) {
      if (!hookMatches(hook.matcher, 'PreToolUse', payload)) continue;
      const result = await this.invoke(hook, payload) as PreToolUseHookResult | undefined;
      if (result?.decision === 'block') return result;
      if (result?.decision === 'approve') {
        approval = result;
        canSkipApproval ||= hook.canApprove && hook.source !== 'project';
      }
    }
    return approval ? { ...approval, ...(canSkipApproval ? { canSkipApproval: true } : {}) } : { decision: 'neutral' };
  }

  async dispatch<E extends SideEffectHookEvent>(event: E, payload: HookPayloadMap[E]): Promise<void> {
    const signal = new AbortController().signal;
    for (const hook of this.registry.snapshot(event)) {
      if (!hookMatches(hook.matcher, event, payload)) continue;
      if (hook.async) await this.deferSideEffect(hook, payload);
      else await this.invoke(hook, payload, signal);
    }
  }
}
