import { describe, expect, it, vi } from 'vitest';
import type {
  HookEventName,
  HookInjectionResult,
  HookPayloadMap,
  HookRuntime,
  InjectingHookEvent,
  PreToolUseHookResult,
  PreToolUsePayload,
  SideEffectHookEvent
} from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  SubAgentManager,
  type LeafAgentRunner
} from '../src/index.js';

class SubagentHooks implements HookRuntime {
  readonly dispatched: Array<{ event: SideEffectHookEvent; payload: HookPayloadMap[SideEffectHookEvent] }> = [];
  configured(event: HookEventName): boolean { return event === 'SubagentStop'; }
  async inject<E extends InjectingHookEvent>(_event: E, _payload: HookPayloadMap[E]): Promise<HookInjectionResult> {
    return { additionalContext: '' };
  }
  async preToolUse(_payload: PreToolUsePayload): Promise<PreToolUseHookResult> { return { decision: 'neutral' }; }
  async dispatch<E extends SideEffectHookEvent>(event: E, payload: HookPayloadMap[E]): Promise<void> {
    this.dispatched.push({ event, payload });
  }
}

describe('SubAgentManager hooks', () => {
  it('passes the same runtime to the leaf and dispatches SubagentStop once', async () => {
    const hooks = new SubagentHooks();
    const run = vi.fn<LeafAgentRunner['run']>(async (request) => {
      expect(request.hooks).toBe(hooks);
      return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
    });
    const manager = new SubAgentManager(
      { run },
      new AgentExecutionScheduler(1),
      () => undefined,
      { resolveHooks: async () => hooks as unknown as HookRuntime }
    );
    const snapshot = manager.start({
      sessionId: 'session-1', workingDirectory: process.cwd(), task: 'task',
      profile: 'general', providerId: 'provider-1', model: 'model-1', readOnly: true, isolation: { type: 'none' }
    });
    await manager.wait([snapshot.id], new AbortController().signal, 1_000);

    expect(run).toHaveBeenCalledOnce();
    expect(hooks.dispatched).toHaveLength(1);
    expect(hooks.dispatched[0]?.event).toBe('SubagentStop');
    expect(hooks.dispatched[0]?.payload).toMatchObject({
      agent: { kind: 'subagent', id: snapshot.id }, lane: `agent:${snapshot.id}`, state: 'completed'
    });
  });
});
