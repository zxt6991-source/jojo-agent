import { describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import type { Message, ModelProvider, ModelRequest, PermissionGate, Tool } from '@desktop-agent/contracts';
import { RuntimeEventEnvelopeSchema } from '@desktop-agent/contracts/runtime';
import { createAgentRuntime } from '../src/index.js';
import { MemoryAgentRuntimeStore } from '../src/memory-store.js';
import { emptyProgressState } from '../src/operation/state.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('public runtime facade', () => {
  it.each(['legacy', 'resource'] as const)('passes %s file input to the provider and preserves metadata for follow-up turns', async (format) => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'answer' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    const runtime = createAgentRuntime({ environment: {
      host: { kind: 'test' }, providers: { resolve: () => provider },
      tools: { resolve: () => ({ snapshot: () => [] }) }, permissions: allow
    } });
    const session = await runtime.openSession({ id: 'files', executionScope: { kind: 'none' } });
    const lane = await session.getLane();
    const legacy = { type: 'text' as const, text: 'Revenue: 1234', attachment: {
      name: 'report.xlsx', relativePath: 'finance/report.xlsx', size: 42, truncated: false
    } };
    const file = format === 'legacy' ? legacy : { type: 'file' as const, attachment: {
      type: 'file' as const, attachmentId: 'att_test', name: 'archive.zip', bytes: 42
    } };
    const first = await (await lane.run({ input: { content: [file] }, providerId: 'p', model: 'm' })).result;
    expect(first.status).toBe('completed');
    expect(requests[0]?.messages.find((message) => message.role === 'user')?.content).toEqual([file]);
    await (await lane.run({ input: 'What was the revenue?', providerId: 'p', model: 'm' })).result;
    expect(requests[1]?.messages.find((message) => message.role === 'user')?.content).toEqual([file]);
    expect(first.messages.find((message) => message.role === 'user')?.content).toEqual([file]);
    await runtime.close();
  });

  it('propagates team member identity through every resolution context', async () => {
    const contexts: Array<import('../src/index.js').RuntimeResolutionContext> = [];
    const provider = new ScriptedProvider([[
      { type: 'text_delta', text: 'team result' },
      { type: 'response_completed', stopReason: 'stop' }
    ]]);
    const runtime = createAgentRuntime({
      environment: {
        host: { kind: 'test' },
        providers: { resolve: (context) => { contexts.push(context); return provider; } },
        tools: { resolve: (context) => { contexts.push(context); return { snapshot: () => [] }; } },
        permissions: allow,
        runContext: { resolve: (context) => { contexts.push(context); return {}; } }
      }
    });
    const session = await runtime.openSession({
      id: 'team:workspace:engineering',
      executionScope: { kind: 'workspace', workingDirectory: '/workspace' }
    });
    const lane = await session.createLane({ id: 'member:architect', parentLaneId: 'main' });
    await (await lane.run({
      input: 'inspect architecture', providerId: 'provider', model: 'model',
      actor: { kind: 'team_member', id: 'architect', profile: 'explore' },
      team: { id: 'engineering', memberId: 'architect', taskId: 'tt_1' }
    })).result;
    expect(contexts).toHaveLength(3);
    expect(contexts.every((context) => context.actor?.kind === 'team_member')).toBe(true);
    expect(contexts.every((context) => context.team?.taskId === 'tt_1')).toBe(true);
    await runtime.close();
  });

  it('propagates an explicit scheduler trigger through every resolution context', async () => {
    const contexts: Array<import('../src/index.js').RuntimeResolutionContext> = [];
    const runtime = createAgentRuntime({
      environment: {
        host: { kind: 'test' },
        providers: { resolve: (context) => {
          contexts.push(context);
          return new ScriptedProvider([[
            { type: 'text_delta', text: 'scheduled result' },
            { type: 'response_completed', stopReason: 'stop' }
          ]]);
        } },
        tools: { resolve: (context) => { contexts.push(context); return { snapshot: () => [] }; } },
        permissions: allow,
        runContext: { resolve: (context) => { contexts.push(context); return {}; } }
      }
    });
    const session = await runtime.openSession({ id: 'scheduled-session', executionScope: { kind: 'none' } });
    await (await (await session.getLane()).run({
      input: 'scheduled task', providerId: 'provider', model: 'model',
      actor: { kind: 'main' }, trigger: { kind: 'scheduler', id: 'sr_1' }
    })).result;

    expect(contexts).toHaveLength(3);
    expect(contexts.every((context) => context.trigger?.kind === 'scheduler')).toBe(true);
    expect(contexts.every((context) => context.trigger?.id === 'sr_1')).toBe(true);
    await runtime.close();
  });

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
        host: { kind: 'test' },
        providers: { resolve: () => provider },
        tools: { resolve: () => ({ snapshot: () => [] }) },
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
        host: { kind: 'test' },
        providers: { resolve: () => provider },
        tools: { resolve: () => ({ snapshot: () => [] }) },
        permissions: allow
      }
    });
    const session = await runtime.openSession({
      id: 'session-2',
      executionScope: { kind: 'workspace', workingDirectory: '/workspace' }
    });
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
        host: { kind: 'test' },
        providers: { resolve: () => provider },
        tools: { resolve: () => ({ snapshot: () => [] }) },
        permissions: allow
      }
    });
    await runtime.openSession({
      id: 'session-recovery',
      executionScope: { kind: 'workspace', workingDirectory: '/workspace' }
    });
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

  it('accepts multimodal input, refreshes dynamic tools, publishes progress, and disposes the source', async () => {
    const requests: ModelRequest[] = [];
    let activated = false;
    let disposed = false;
    const manifest: Tool = {
      definition: { name: 'manifest', description: 'activate', inputSchema: { type: 'object' } },
      execute: async (_input, context) => {
        context.onProgress('discovering');
        activated = true;
        return { callId: '', ok: true, content: 'activated' };
      }
    };
    const dynamic: Tool = {
      definition: { name: 'dynamic', description: 'dynamic', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: '', ok: true, content: 'dynamic result' })
    };
    let step = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (step++ === 0) {
          yield { type: 'tool_call_completed', call: { id: 'manifest-1', name: 'manifest', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };
    const eventTypes: string[] = [];
    const runtime = createAgentRuntime({
      environment: {
        host: { kind: 'test' },
        providers: { resolve: () => provider },
        tools: {
          resolve: () => ({
            snapshot: () => activated ? [manifest, dynamic] : [manifest],
            dispose: async () => { disposed = true; }
          })
        },
        permissions: allow
      }
    });
    runtime.subscribe((event) => eventTypes.push(event.event.type));
    const session = await runtime.openSession({ id: 'multimodal', executionScope: { kind: 'none' } });
    const result = await (await (await session.getLane()).run({
      input: {
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'sample.png' }
        ]
      },
      providerId: 'test',
      model: 'scripted'
    })).result;

    expect(result.status).toBe('completed');
    expect(requests[0]?.messages.at(-1)?.content).toMatchObject([
      { type: 'text', text: 'inspect' },
      { type: 'image', mimeType: 'image/png', name: 'sample.png' }
    ]);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(['manifest']);
    expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(['manifest', 'dynamic']);
    expect(eventTypes).toContain('tool.progress');
    expect(disposed).toBe(true);
    expect((await session.getSnapshot()).session.executionScope).toEqual({ kind: 'none' });
    await runtime.close();
  });

  it('uses the environment summarizer and emits stable compaction events', async () => {
    const store = new MemoryAgentRuntimeStore();
    const summarize = vi.fn(async (_source: string) => 'stable compacted summary');
    const runtime = createAgentRuntime({
      store,
      environment: {
        host: { kind: 'test' },
        providers: { resolve: () => new ScriptedProvider([[
          { type: 'text_delta', text: 'answer after compaction' },
          { type: 'response_completed', stopReason: 'stop' }
        ]]) },
        tools: { resolve: () => ({ snapshot: () => [] }) },
        permissions: allow,
        summarizer: { summarize: ({ source }) => summarize(source) }
      }
    });
    const session = await runtime.openSession({ id: 'compaction', executionScope: { kind: 'none' } });
    const old: Message = {
      id: 'old-message',
      role: 'user',
      createdAt: '2026-08-20T00:00:00.000Z',
      content: [{ type: 'text', text: 'old durable requirement '.repeat(2_000) }]
    };
    await store.appendEntry({
      id: old.id,
      sessionId: session.id,
      parentId: null,
      type: 'message',
      message: old
    });
    await store.saveLane({ sessionId: session.id, name: 'main', leafId: old.id, currentOperationId: null });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.event.type));

    const result = await (await (await session.getLane()).run({
      input: 'current requirement',
      providerId: 'test',
      model: 'scripted',
      budget: { contextWindowTokens: 2_048, maxOutputTokens: 256 }
    })).result;

    expect(result.status).toBe('completed');
    expect(summarize).toHaveBeenCalledOnce();
    expect(events).toContain('context.compacted');
    await runtime.close();
  });
});
