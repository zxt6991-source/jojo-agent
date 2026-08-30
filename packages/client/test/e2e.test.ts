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
      const beforePatch = await session.snapshot();
      await expect(session.patch({
        labels: ['sdk'], favorite: true, expectedRevision: beforePatch.revision
      })).resolves.toMatchObject({ labels: ['sdk'], favorite: true, revision: beforePatch.revision + 1 });
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

  it('manages durable schedules over REST and receives scheduler events over WebSocket', async () => {
    const server = await createNetworkServer({
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'scheduled SDK answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow,
      http: { host: '127.0.0.1', port: 0, token: 'scheduler-token' }
    });
    const address = await server.listen();
    const client = new JojoClient({
      baseUrl: address,
      token: 'scheduler-token',
      reconnect: false,
      runPollIntervalMs: 10
    });
    try {
      await client.connect();
      await expect(client.getCapabilities()).resolves.toMatchObject({
        scheduler: { enabled: true, targets: ['agent'] }
      });
      const session = await client.createSession({ executionScope: { kind: 'none' } });
      const changed = new Promise<string>((resolve) => {
        const unsubscribe = client.subscribeSchedules((event) => {
          if (event.type !== 'schedule.changed') return;
          unsubscribe();
          resolve(event.schedule.id);
        });
      });
      const schedule = await client.createSchedule({
        name: 'SDK schedule',
        enabled: false,
        spec: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
        target: {
          kind: 'agent',
          sessionId: session.id,
          input: { content: [{ type: 'text', text: 'run from schedule' }] },
          providerId: 'test',
          model: 'scripted'
        }
      });
      await expect(changed).resolves.toBe(schedule.id);
      await expect(client.updateSchedule(schedule.id, {
        description: 'updated over REST', expectedRevision: schedule.revision
      })).resolves.toMatchObject({ description: 'updated over REST', revision: schedule.revision + 1 });
      await expect(client.listSchedules()).resolves.toMatchObject([{ id: schedule.id }]);

      const started = await client.runScheduleNow(schedule.id);
      let terminal = await client.getScheduleRun(started.id);
      for (let attempts = 0; attempts < 50 && terminal.status !== 'completed'; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        terminal = await client.getScheduleRun(started.id);
      }
      expect(terminal).toMatchObject({ status: 'completed', resultPreview: 'scheduled SDK answer' });
      await expect(client.listScheduleRuns(schedule.id, { states: ['completed'] }))
        .resolves.toMatchObject([{ id: started.id }]);
      await client.deleteSchedule(schedule.id);
      await expect(client.getSchedule(schedule.id)).rejects.toMatchObject({ protocol: { code: 'schedule_not_found' } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
