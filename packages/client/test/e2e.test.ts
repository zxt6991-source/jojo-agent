import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate, Tool } from '@desktop-agent/contracts';
import { createNetworkServer } from '../../../apps/server/src/index.js';
import { JojoClient } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('Jojo client SDK', () => {
  it('runs a remote turn and recovers the result through the queryable run snapshot', async () => {
    const server = await createNetworkServer({
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'sdk answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow,
      http: { host: '127.0.0.1', port: 0, token: 'sdk-token' }
    });
    const address = await server.listen();
    const client = new JojoClient({ baseUrl: address, token: 'sdk-token', reconnect: false, runPollIntervalMs: 10 });
    try {
      await client.connect();
      const session = await client.createSession({ title: 'SDK', executionScope: { kind: 'none' } });
      const run = await session.run({ input: 'hello', providerId: 'test', model: 'test', laneId: 'main' });
      await expect(run.result()).resolves.toMatchObject({ status: 'completed', finalText: 'sdk answer' });
      await expect(session.transcript()).resolves.toMatchObject({
        items: [{ message: { role: 'user' } }, { message: { role: 'assistant' } }]
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps a run pending until a remote client resolves approval', async () => {
    const tool: Tool = {
      definition: { name: 'approved_tool', description: 'approval test', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: '', ok: true, content: 'approved' })
    };
    const ask: PermissionGate = {
      check: async (call, context) => ({
        decision: 'ask',
        request: { requestId: 'approval-sdk', sessionId: context.sessionId, call, reason: 'Confirm test tool.' }
      })
    };
    const server = await createNetworkServer({
      providers: { resolve: () => new ScriptedProvider([
        [
          { type: 'tool_call_completed', call: { id: 'tool-1', name: 'approved_tool', input: {} } },
          { type: 'response_completed', stopReason: 'tool_calls' }
        ],
        [
          { type: 'text_delta', text: 'approval complete' },
          { type: 'response_completed', stopReason: 'stop' }
        ]
      ]) },
      permissions: ask,
      tools: { resolve: () => ({ snapshot: () => [tool] }) },
      http: { host: '127.0.0.1', port: 0, token: 'approval-token' }
    });
    const address = await server.listen();
    const client = new JojoClient({ baseUrl: address, token: 'approval-token', reconnect: false, runPollIntervalMs: 10 });
    try {
      await client.connect();
      const session = await client.createSession({ executionScope: { kind: 'none' } });
      const run = await session.run({ input: 'use tool', providerId: 'test', model: 'test', laneId: 'main' });
      let approvalId: string | undefined;
      for (let attempts = 0; attempts < 50 && !approvalId; attempts += 1) {
        approvalId = (await session.snapshot()).pendingApprovals[0]?.id;
        if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(approvalId).toBe('approval-sdk');
      await client.resolveApproval(approvalId!, 'allow');
      await expect(run.result()).resolves.toMatchObject({ finalText: 'approval complete' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
