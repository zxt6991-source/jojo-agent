import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import type { PermissionGate } from '@desktop-agent/contracts';
import { createAgentRuntime } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('runtime public query surface', () => {
  it('lists durable sessions and paginates a lane transcript', async () => {
    const runtime = createAgentRuntime({
      environment: {
        host: { kind: 'test' },
        providers: { resolve: () => new ScriptedProvider([[
          { type: 'text_delta', text: 'answer' },
          { type: 'response_completed', stopReason: 'stop' }
        ]]) },
        tools: { resolve: () => ({ snapshot: () => [] }) },
        permissions: allow
      }
    });
    const session = await runtime.openSession({ id: 'query-session', executionScope: { kind: 'none' } });
    await (await (await session.getLane()).run({ input: 'question', providerId: 'test', model: 'test' })).result;

    await expect(runtime.listSessions()).resolves.toMatchObject([
      { id: 'query-session', executionScope: { kind: 'none' } }
    ]);
    const lane = await session.getLane();
    const first = await lane.readTranscript({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe('1');
    await expect(lane.readTranscript({ cursor: first.nextCursor!, limit: 1 })).resolves.toMatchObject({
      items: [{ role: 'assistant' }]
    });
    await runtime.close();
  });
});
