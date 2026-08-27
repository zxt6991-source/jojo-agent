import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import type { PermissionGate } from '@desktop-agent/contracts';
import { RuntimeEventEnvelopeSchema } from '@desktop-agent/contracts/runtime';
import { createAgentRuntime } from '../src/index.js';
import { MemoryAgentRuntimeStore } from '../src/memory-store.js';
import { emptyProgressState } from '../src/operation/state.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('public runtime facade', () => {
  it('continues conversation through a lane and emits stable monotonic events', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'first answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ],
      [
        { type: 'text_delta', text: 'follow-up answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);
    let nextId = 0;
    const runtime = createAgentRuntime({
      idGenerator: () => `id-${++nextId}`,
      environment: {
        providers: { resolve: () => provider },
        tools: { resolve: () => [] },
        permissions: allow
      }
    });
    const events: unknown[] = [];
    runtime.subscribe(() => { throw new Error('observer failure'); });
    runtime.subscribe((event) => events.push(event));

    const session = await runtime.openSession({
      id: 'session-1',
      executionScope: { kind: 'workspace', workingDirectory: '/workspace' }
    });
    const lane = await session.getLane();
    const first = await (await lane.run({ input: 'first', providerId: 'provider', model: 'model' })).result;
    const second = await (await lane.run({ input: 'follow up', providerId: 'provider', model: 'model' })).result;

    expect(first).toMatchObject({ status: 'completed', finalText: 'first answer' });
    expect(second).toMatchObject({ status: 'completed', finalText: 'follow-up answer' });
    expect(events.every((event) => RuntimeEventEnvelopeSchema.safeParse(event).success)).toBe(true);
    expect(events.map((event: any) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event: any) => event.event.type)).toEqual([
      'run.started', 'assistant.delta', 'run.completed',
      'run.started', 'assistant.delta', 'run.completed'
    ]);
    await expect(lane.getSnapshot()).resolves.toMatchObject({ messageCount: 4 });
    await expect(session.getSnapshot()).resolves.toMatchObject({
      session: { id: 'session-1', executionScope: { kind: 'workspace', workingDirectory: '/workspace' } },
      lanes: [{ id: 'main', sessionId: 'session-1' }]
    });
    await runtime.close();
  });

  it('maps child lanes from a parent snapshot without changing the parent', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: 'main' }, { type: 'response_completed', stopReason: 'stop' }],
      [{ type: 'text_delta', text: 'child' }, { type: 'response_completed', stopReason: 'stop' }]
    ]);
    const runtime = createAgentRuntime({
      environment: {
        providers: { resolve: () => provider },
        tools: { resolve: () => [] },
        permissions: allow
      }
    });
    const session = await runtime.openSession({ id: 'session-2', workingDirectory: '/workspace' });
    const main = await session.getLane();
    await (await main.run({ input: 'main task', providerId: 'provider', model: 'model' })).result;
    const mainLeaf = (await main.getSnapshot()).leafEntryId;
    const child = await session.createLane({ id: 'agent:child', parentLaneId: 'main' });
    const result = await (await child.run({ input: 'child task', providerId: 'provider', model: 'model' })).result;

    expect(result.finalText).toBe('child');
    expect((await main.getSnapshot()).leafEntryId).toBe(mainLeaf);
    expect((await child.getSnapshot()).messageCount).toBe(4);
    await runtime.close();
  });

  it('keeps crash resume distinct from lane conversation continuation', async () => {
    const store = new MemoryAgentRuntimeStore();
    const provider = new ScriptedProvider([[
      { type: 'text_delta', text: 'recovered' },
      { type: 'response_completed', stopReason: 'stop' }
    ]]);
    const runtime = createAgentRuntime({
      store,
      environment: {
        providers: { resolve: () => provider },
        tools: { resolve: () => [] },
        permissions: allow
      }
    });
    await runtime.openSession({ id: 'session-recovery', workingDirectory: '/workspace' });
    await store.startOperation({
      id: 'operation-recovery',
      sessionId: 'session-recovery',
      lane: 'main',
      kind: 'run',
      createdAt: 1,
      providerId: 'provider',
      model: 'model',
      maxIterations: 8
    }, {
      phase: 'model_pending',
      operationId: 'operation-recovery',
      lane: 'main',
      iteration: 0,
      outputContinuations: 0,
      progress: emptyProgressState(8),
      responseEntryId: 'response-recovery',
      usageId: 'usage-recovery',
      request: {
        providerId: 'provider',
        model: 'model',
        toolNames: [],
        maxOutputTokens: 1_024,
        finalResponseOnly: false
      },
      attempt: 1
    });
    const eventTypes: string[] = [];
    runtime.subscribe((event) => eventTypes.push(event.event.type));

    const result = await (await runtime.resumeOperation({ operationId: 'operation-recovery' })).result;

    expect(result).toMatchObject({ status: 'completed', finalText: 'recovered' });
    expect(eventTypes).toEqual(['run.resumed', 'assistant.delta', 'run.completed']);
    await runtime.close();
  });
});
