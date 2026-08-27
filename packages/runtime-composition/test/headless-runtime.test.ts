import { describe, expect, it } from 'vitest';
import { ScriptedProvider, verifyRuntimeContract } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate, Tool } from '@desktop-agent/contracts';
import { createJojoRuntime, type RuntimeCapability } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('headless Jojo runtime composition', () => {
  it('runs the public Session/Lane/Run contract in plain Node', async () => {
    const tool: Tool = {
      definition: { name: 'headless_echo', description: 'echo', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: '', ok: true, content: 'headless result' })
    };
    const capability: RuntimeCapability = {
      contribute(builder) { builder.addTools([tool]); }
    };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'echo-1', name: 'headless_echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'headless complete' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);
    const runtime = await createJojoRuntime({
      host: { kind: 'server', instanceId: 'node-smoke' },
      providers: { resolve: () => provider },
      permissions: allow,
      capabilities: [capability]
    });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.event.type));
    const session = await runtime.openSession({ id: 'headless-session', executionScope: { kind: 'none' } });
    const result = await (await (await session.getLane()).run({
      input: { content: [{ type: 'text', text: 'run headlessly' }] },
      providerId: 'scripted',
      model: 'scripted'
    })).result;

    expect(result).toMatchObject({ status: 'completed', finalText: 'headless complete' });
    expect(events).toEqual([
      'run.started',
      'tool.requested',
      'tool.started',
      'tool.completed',
      'assistant.delta',
      'run.completed'
    ]);
    await runtime.close();
  });

  it('passes the reusable Runtime Host conformance suite', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'contract complete' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    const report = await verifyRuntimeContract(runtime, {
      sessionId: 'server-contract',
      providerId: 'scripted',
      model: 'scripted'
    });
    expect(report.result.finalText).toBe('contract complete');
    await runtime.close();
  });
});
