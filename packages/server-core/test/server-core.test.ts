import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate } from '@desktop-agent/contracts';
import { createJojoRuntime } from '@desktop-agent/runtime-composition';
import { createJojoAppService, ServerApprovalBroker } from '@desktop-agent/app-service';
import type { RequestContext } from '@desktop-agent/server-protocol';
import { createJojoServerCore } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const context: RequestContext = {
  requestId: 'request-1',
  principal: { id: 'local', type: 'local', scopes: ['admin'] },
  connectionId: 'connection-1',
  clientId: 'client-1'
};

describe('server core', () => {
  it('coordinates leases, idempotent mutations, run query, and transcript projection', async () => {
    const approvalBroker = new ServerApprovalBroker();
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'remote answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow,
      approval: approvalBroker
    });
    const service = createJojoAppService(runtime, { approvalBroker });
    const core = createJojoServerCore(service, { serverId: 'server-test' });

    const created = await core.createSession(context, {
      id: 'server-session', title: 'Remote', executionScope: { kind: 'none' }
    }, 'same-create');
    const repeated = await core.createSession(context, {
      id: 'server-session', title: 'Remote', executionScope: { kind: 'none' }
    }, 'same-create');
    expect(repeated.id).toBe(created.id);
    await expect(core.startRun(context, created.id, {
      laneId: 'main', input: { content: [{ type: 'text', text: 'hello' }] }, providerId: 'test', model: 'test'
    })).rejects.toMatchObject({ protocol: { code: 'session_locked' } });

    await core.attach(context, created.id, 'control');
    const patched = await core.patchSession(context, created.id, {
      labels: ['durable'], favorite: true, expectedRevision: created.revision
    });
    expect(patched).toMatchObject({ labels: ['durable'], favorite: true, revision: created.revision + 1 });
    await expect(core.patchSession(context, created.id, {
      title: 'stale', expectedRevision: created.revision
    })).rejects.toThrow('revision_conflict');
    const started = await core.startRun(context, created.id, {
      laneId: 'main', input: { content: [{ type: 'text', text: 'hello' }] }, providerId: 'test', model: 'test'
    }, 'run-key');
    let run = await core.getRun(context, created.id, started.id);
    for (let attempts = 0; attempts < 20 && !run.result; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = await core.getRun(context, created.id, started.id);
    }
    expect(run).toMatchObject({ status: 'completed', result: { finalText: 'remote answer' } });
    await expect(core.transcript(context, created.id)).resolves.toMatchObject({
      items: [{ message: { role: 'user' } }, { message: { role: 'assistant' } }]
    });
    await core.close();
  });

  it('rejects a second control lease without cancelling the first client run state', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    const core = createJojoServerCore(createJojoAppService(runtime));
    await core.createSession(context, { id: 'locked', executionScope: { kind: 'none' } });
    await core.attach(context, 'locked', 'control');
    await expect(core.attach({ ...context, connectionId: 'connection-2', clientId: 'client-2' }, 'locked', 'control'))
      .rejects.toMatchObject({ protocol: { code: 'session_locked' } });
    core.closeConnection('connection-1');
    await expect(core.attach({ ...context, connectionId: 'connection-2', clientId: 'client-2' }, 'locked', 'control'))
      .resolves.toMatchObject({ mode: 'control' });
    await core.close();
  });
});
