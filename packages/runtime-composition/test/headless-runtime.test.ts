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

it('uses per-model limits for context diagnostics and the same capped request budget', async () => {
  const { legacyModelConfig, resolveModelForRun } = await import('@desktop-agent/contracts');
  const models = [legacyModelConfig('small', 64_000, 4_096), { ...legacyModelConfig('large', 1_000_000, 128_000), defaultOutputTokens: 8_192 }];
  const requests: number[] = [];
  const windows: number[] = [];
  const provider = new ScriptedProvider(Array.from({ length: 2 }, () => [
    { type: 'text_delta' as const, text: 'done' }, { type: 'response_completed' as const, stopReason: 'stop' as const }
  ]));
  const runtime = await createJojoRuntime({
    host: { kind: 'server' }, permissions: allow,
    providers: {
      resolve: () => ({ stream: (request) => { requests.push(request.maxOutputTokens!); return provider.stream(); } }),
      resolveLimits: (context, request) => resolveModelForRun({ models }, context.model, request)
    },
    telemetry: { diagnostic: (event) => { if (event.type === 'context.updated') windows.push(event.contextWindowTokens); } }
  });
  try {
    const session = await runtime.openSession({ id: 'metadata-switch', executionScope: { kind: 'none' } });
    const lane = await session.getLane();
    for (const model of ['small', 'large']) {
      const result = await (await lane.run({ providerId: 'same', model, input: { content: [{ type: 'text', text: 'hello' }] } })).result;
      expect(result.status).toBe('completed');
    }
    expect(windows).toEqual([64_000, 1_000_000]);
    expect(requests).toEqual([4_096, 8_192]);
  } finally { await runtime.close(); }
});
