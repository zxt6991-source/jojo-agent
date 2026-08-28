import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate } from '@desktop-agent/contracts';
import { createJojoRuntime } from '@desktop-agent/runtime-composition';
import { MemoryServerStateStore, ServerRecoveryCoordinator } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('ServerRecoveryCoordinator', () => {
  it('reconciles session sagas, approvals, and non-terminal runs conservatively', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await runtime.openSession({ id: 'existing', executionScope: { kind: 'none' } });
    await runtime.openSession({ id: 'legacy', executionScope: { kind: 'none' } });
    const store = new MemoryServerStateStore();
    await store.sessions.createCreating({ sessionId: 'existing', title: 'kept' });
    await store.sessions.createCreating({ sessionId: 'stale', title: 'removed' });
    await store.runs.createAccepted({
      id: 'run-1', sessionId: 'existing', laneId: 'main', providerId: 'test', model: 'test', inputHash: 'hash'
    });
    await store.approvals.createPending({
      id: 'approval-1', sessionId: 'existing', runId: 'run-1', laneId: 'main',
      toolCallId: 'call-1', toolName: 'write', reason: 'approval', requestHash: 'hash'
    });

    await new ServerRecoveryCoordinator(runtime, store).reconcile();

    expect(await store.sessions.get('existing')).toMatchObject({ state: 'active', title: 'kept' });
    expect(await store.sessions.get('legacy')).toMatchObject({ state: 'active', labels: [] });
    expect(await store.sessions.get('stale')).toBeUndefined();
    expect(await store.approvals.get('approval-1')).toMatchObject({
      status: 'interrupted', interruptedReason: 'server_restart_without_durable_suspension'
    });
    expect(await store.runs.get('run-1')).toMatchObject({
      status: 'interrupted', error: { code: 'run_start_not_committed' }
    });
    await runtime.close();
    await store.close();
  });

  it('projects a durable Runtime terminal fact instead of marking it interrupted', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'recovered terminal result' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    const session = await runtime.openSession({ id: 'session-terminal', executionScope: { kind: 'none' } });
    const handle = await (await session.getLane('main')).run({
      runId: 'run-terminal',
      input: { content: [{ type: 'text', text: 'hello' }] },
      providerId: 'test', model: 'test', actor: { kind: 'main' }
    });
    await handle.result;
    const store = new MemoryServerStateStore();
    await store.sessions.ensureActive({ sessionId: 'session-terminal' });
    const accepted = await store.runs.createAccepted({
      id: 'run-terminal', sessionId: 'session-terminal', laneId: 'main',
      providerId: 'test', model: 'test', inputHash: 'hash'
    });
    await store.runs.markStarting('run-terminal', accepted.version);

    await new ServerRecoveryCoordinator(runtime, store).reconcile();

    expect(await store.runs.get('run-terminal')).toMatchObject({
      status: 'completed', result: { finalText: 'recovered terminal result' }
    });
    await runtime.close();
    await store.close();
  });
});
