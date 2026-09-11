import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider, Tool } from '@desktop-agent/contracts';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { OpenAICompatibleProvider } from '@desktop-agent/providers';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const tools = (id: string) => frame({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'effect', arguments: '{}' } }] } }] });
const finish = (reason: string) => frame({ choices: [{ delta: {}, finish_reason: reason }] });
afterEach(() => vi.unstubAllGlobals());

describe('provider stream failures across durable runtime', () => {
  it.each(['truncated', 'error', 'protocol', 'third_party'])(
    'persists %s failure, does not replay prior tools, and releases the lane', async (kind) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'stream-runtime-'));
      const filename = path.join(directory, 'runtime.sqlite');
      const store = new SqliteAgentRuntimeStore(filename);
      const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'effect complete' }));
      const tool: Tool = { definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } }, execute };
      const code = kind === 'error' ? 'provider_stream_error' : kind === 'protocol' ? 'provider_protocol_error' : 'provider_stream_incomplete';
      const failure = tools('unsafe') + (kind === 'error' ? frame({ error: { message: 'upstream' } }) : kind === 'protocol' ? 'data: bad\n\n' : '');
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(tools('prior') + finish('tool_calls')))
        .mockResolvedValueOnce(new Response('busy', { status: 429 }))
        .mockResolvedValueOnce(new Response(failure))
        .mockResolvedValueOnce(new Response(finish('stop')));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new OpenAICompatibleProvider({ apiKey: 'secret', requestPolicy: { baseRetryDelayMs: 0, maxRetryDelayMs: 0 } });
      let step = 0;
      const thirdParty: ModelProvider = { async *stream() {
        step++;
        if (step <= 2) yield { type: 'tool_call_completed', call: { id: step === 1 ? 'prior' : 'unsafe', name: 'effect', input: {} } };
        if (step !== 2) yield { type: 'response_completed', stopReason: step === 1 ? 'tool_calls' : 'stop' };
      } };
      const environment = {
        host: { kind: 'test' as const }, providers: { resolve: () => kind === 'third_party' ? thirdParty : adapter },
        tools: { resolve: () => ({ snapshot: () => [tool] }) },
        permissions: { check: async () => ({ decision: 'allow' as const }) }
      };
      const runtime = createAgentRuntime({ store, environment });
      let reopened: SqliteAgentRuntimeStore | undefined;
      try {
        const session = await runtime.openSession({ id: 'session', executionScope: { kind: 'none' } });
        const lane = await session.getLane();
        const run = await lane.run({ input: 'work', providerId: 'test', model: 'test' });
        expect(await run.result).toMatchObject({ status: 'failed', error: { code } });
        expect(execute).toHaveBeenCalledOnce();
        expect(await store.loadOperation(run.id)).toMatchObject({ state: { phase: 'failed', error: { code } } });
        const storedLane = await store.getLane('session', 'main');
        expect(storedLane?.currentOperationId).toBeNull();
        expect(JSON.stringify(await store.readPath(storedLane?.leafId ?? null))).not.toContain('unsafe');
        if (kind !== 'third_party') {
          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)
            .toBe((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body);
        }
        expect(await (await lane.run({ input: 'next', providerId: 'test', model: 'test' })).result).toMatchObject({ status: 'completed' });
        expect(execute).toHaveBeenCalledOnce();
        await runtime.close();
        store.close();
        reopened = new SqliteAgentRuntimeStore(filename);
        expect(await reopened.loadOperation(run.id)).toMatchObject({ state: { phase: 'failed', error: { code } } });
        const restored = createAgentRuntime({ store: reopened, environment });
        try {
          expect(await (await restored.inspectRun(run.id))?.result).toMatchObject({ status: 'failed', error: { code } });
        } finally { await restored.close(); }
      } finally {
        await runtime.close();
        if (reopened) reopened.close(); else store.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
