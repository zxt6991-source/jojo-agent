import { describe, expect, it, vi } from 'vitest';
import type { PreToolUsePayload, UserPromptSubmitPayload } from '@desktop-agent/contracts';
import { DefaultHookRuntime, HookRegistry, MemoryHookInvocationStore } from '../src/index.js';

function envelope(event: PreToolUsePayload['event'] | UserPromptSubmitPayload['event']) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${crypto.randomUUID()}`,
    event,
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    operationId: 'operation-1',
    lane: 'main',
    agent: { kind: 'main' as const },
    workingDirectory: process.cwd(),
    provider: { id: 'provider-1', model: 'model-1' },
    transport: 'cli' as const
  };
}

function preTool(): PreToolUsePayload {
  return {
    ...envelope('PreToolUse'),
    event: 'PreToolUse',
    toolCallId: 'call-1',
    toolName: 'terminal',
    toolInput: { command: 'git status' }
  };
}

describe('DefaultHookRuntime', () => {
  it('aggregates approval without short-circuiting and lets a later block win', async () => {
    const registry = new HookRegistry();
    const approve = vi.fn(async () => ({ decision: 'approve' as const }));
    const block = vi.fn(async () => ({ decision: 'block' as const, reason: 'policy' }));
    registry.on('PreToolUse', approve, { id: 'user.approve', source: 'user', canApprove: true });
    registry.on('PreToolUse', block, { id: 'builtin.block', matcher: '^terminal$' });

    await expect(new DefaultHookRuntime(registry).preToolUse(preTool())).resolves.toEqual({
      decision: 'block', reason: 'policy'
    });
    expect(approve).toHaveBeenCalledOnce();
    expect(block).toHaveBeenCalledOnce();
  });

  it('only grants approval capability to explicitly enabled user hooks', async () => {
    const registry = new HookRegistry();
    registry.on('PreToolUse', async () => ({ decision: 'approve' }), {
      id: 'project.approve', source: 'project', canApprove: true
    });
    expect(await new DefaultHookRuntime(registry).preToolUse(preTool())).toEqual({ decision: 'approve' });
  });

  it('reuses a completed durable invocation when an operation resumes', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn(async () => ({ decision: 'block' as const, reason: 'once' }));
    registry.on('PreToolUse', handler, { id: 'builtin.once' });
    const runtime = new DefaultHookRuntime(registry, { invocationStore: new MemoryHookInvocationStore() });

    expect(await runtime.preToolUse(preTool())).toMatchObject({ decision: 'block' });
    expect(await runtime.preToolUse(preTool())).toMatchObject({ decision: 'block' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('chains bounded context in registration order', async () => {
    const registry = new HookRegistry();
    registry.on('UserPromptSubmit', async () => ({ additionalContext: 'first' }), { id: 'builtin.first' });
    registry.on('UserPromptSubmit', async () => ({ additionalContext: 'second' }), { id: 'builtin.second' });
    const payload: UserPromptSubmitPayload = {
      ...envelope('UserPromptSubmit'), event: 'UserPromptSubmit', userInput: 'question'
    };
    expect(await new DefaultHookRuntime(registry).inject('UserPromptSubmit', payload)).toEqual({
      additionalContext: 'first\n\nsecond', hookIds: ['builtin.first', 'builtin.second']
    });
  });

  it('replays an incomplete durable side-effect invocation after restart', async () => {
    const store = new MemoryHookInvocationStore();
    const registry = new HookRegistry();
    const handler = vi.fn(async () => undefined);
    registry.on('Stop', handler, { id: 'user.notify', source: 'user' });
    const payload = {
      ...envelope('UserPromptSubmit'),
      event: 'Stop' as const,
      stopReason: 'stop',
      toolsUsed: []
    };
    await store.beginInvocation({
      id: 'operation-1:Stop:operation:user.notify',
      eventId: payload.eventId,
      hookId: 'user.notify',
      event: 'Stop',
      sessionId: payload.sessionId,
      operationId: payload.operationId,
      subjectId: 'operation',
      state: 'pending',
      payload
    });

    await new DefaultHookRuntime(registry, { invocationStore: store, recoveryLeaseMs: 0 }).recoverPendingSideEffects();
    expect(handler).toHaveBeenCalledOnce();
    expect(await store.getInvocation('operation-1:Stop:operation:user.notify')).toMatchObject({ state: 'completed' });
  });

  it('durably enqueues async side-effect hooks without blocking dispatch', async () => {
    const store = new MemoryHookInvocationStore();
    const registry = new HookRegistry();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    registry.on('Stop', async () => pending, { id: 'user.async', source: 'user', async: true });
    const payload = {
      ...envelope('UserPromptSubmit'), event: 'Stop' as const, stopReason: 'stop', toolsUsed: []
    };
    await new DefaultHookRuntime(registry, { invocationStore: store }).dispatch('Stop', payload);
    expect(await store.getInvocation('operation-1:Stop:operation:user.async')).toMatchObject({ state: 'running' });
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.getInvocation('operation-1:Stop:operation:user.async')).toMatchObject({ state: 'completed' });
  });
});
