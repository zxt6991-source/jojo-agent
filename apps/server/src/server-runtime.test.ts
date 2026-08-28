import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate } from '@desktop-agent/contracts';
import type { RequestContext } from '@desktop-agent/server-protocol';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import { createHeadlessServer } from './index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const context: RequestContext = {
  requestId: 'request-1',
  principal: { id: 'local', type: 'local', scopes: ['admin'] }
};
const controlContext: RequestContext = {
  ...context,
  connectionId: 'connection-1',
  clientId: 'client-1'
};

describe('headless server consumer', () => {
  it('uses only Runtime Public API and Runtime Composition', async () => {
    const server = await createHeadlessServer({
      instanceId: 'server-test',
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'server answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    await server.service.openSession({ id: 'server-session', executionScope: { kind: 'none' } });
    const started = await server.service.run('server-session', 'main', {
      input: { content: [{ type: 'text', text: 'hello server' }] },
      providerId: 'test',
      model: 'scripted',
      actor: { kind: 'main' }
    });

    await expect(started.result).resolves.toMatchObject({
      status: 'completed',
      finalText: 'server answer'
    });
    await expect(server.service.getLane('server-session')).resolves.toMatchObject({ messageCount: 2 });
    await server.close();
  });

  it('keeps metadata and terminal run results after a full server restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-headless-restart-'));
    const runtimeFile = path.join(directory, 'runtime.sqlite');
    const runtimeStoreA = new SqliteAgentRuntimeStore(runtimeFile);
    const serverA = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreA,
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'persisted answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    const session = await serverA.appService.createSession(context, {
      id: 'durable-session', title: 'Durable title', labels: ['restart'], executionScope: { kind: 'none' }
    });
    const started = await serverA.appService.startRun(context, session.id, {
      laneId: 'main', input: { content: [{ type: 'text', text: 'hello' }] }, providerId: 'test', model: 'scripted'
    });
    let completed = await serverA.appService.getRun(context, session.id, started.id);
    for (let attempt = 0; attempt < 40 && completed.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await serverA.appService.getRun(context, session.id, started.id);
    }
    expect(completed).toMatchObject({ status: 'completed', result: { finalText: 'persisted answer' } });
    const revision = (await serverA.appService.getSession(context, session.id)).revision;
    await serverA.close();
    runtimeStoreA.close();

    const runtimeStoreB = new SqliteAgentRuntimeStore(runtimeFile);
    const serverB = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreB,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await expect(serverB.appService.getSession(context, session.id)).resolves.toMatchObject({
      title: 'Durable title', labels: ['restart'], revision
    });
    await expect(serverB.appService.getRun(context, session.id, started.id)).resolves.toMatchObject({
      status: 'completed', result: { finalText: 'persisted answer' }
    });
    await serverB.close();
    runtimeStoreB.close();
  });

  it('reuses a completed session mutation idempotently after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-idempotency-restart-'));
    const runtimeFile = path.join(directory, 'runtime.sqlite');
    const input = {
      id: 'idempotent-session', title: 'Exactly once-ish', executionScope: { kind: 'none' as const }
    };
    const runtimeStoreA = new SqliteAgentRuntimeStore(runtimeFile);
    const serverA = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreA,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    const first = await serverA.core.createSession(context, input, 'session-create-key');
    await serverA.close();
    runtimeStoreA.close();

    const runtimeStoreB = new SqliteAgentRuntimeStore(runtimeFile);
    const serverB = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreB,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await expect(serverB.core.createSession(context, input, 'session-create-key')).resolves.toEqual(first);
    await expect(serverB.core.createSession(context, {
      ...input, title: 'Conflicting request'
    }, 'session-create-key')).rejects.toMatchObject({ protocol: { code: 'idempotency_conflict' } });
    expect((await serverB.core.listSessions(context)).filter((session) => session.id === input.id)).toHaveLength(1);
    await serverB.close();
    runtimeStoreB.close();
  });

  it('reuses the original run identity after an idempotent restart retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-run-idempotency-restart-'));
    const runtimeFile = path.join(directory, 'runtime.sqlite');
    const runInput = {
      laneId: 'main',
      input: { content: [{ type: 'text' as const, text: 'run once' }] },
      providerId: 'test',
      model: 'scripted'
    };
    const runtimeStoreA = new SqliteAgentRuntimeStore(runtimeFile);
    const serverA = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreA,
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'single execution' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    await serverA.core.createSession(controlContext, {
      id: 'run-idempotency-session', executionScope: { kind: 'none' }
    }, 'create-run-session');
    await serverA.core.attach(controlContext, 'run-idempotency-session', 'control');
    const first = await serverA.core.startRun(
      controlContext, 'run-idempotency-session', runInput, 'run-start-key'
    );
    let terminal = await serverA.core.getRun(controlContext, 'run-idempotency-session', first.id);
    for (let attempt = 0; attempt < 40 && terminal.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      terminal = await serverA.core.getRun(controlContext, 'run-idempotency-session', first.id);
    }
    expect(terminal).toMatchObject({ status: 'completed', result: { finalText: 'single execution' } });
    await serverA.close();
    runtimeStoreA.close();

    const runtimeStoreB = new SqliteAgentRuntimeStore(runtimeFile);
    const serverB = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreB,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await serverB.core.attach(controlContext, 'run-idempotency-session', 'control');
    await expect(serverB.core.startRun(
      controlContext, 'run-idempotency-session', runInput, 'run-start-key'
    )).resolves.toEqual(first);
    await expect(serverB.core.transcript(controlContext, 'run-idempotency-session')).resolves.toMatchObject({
      items: [{ message: { role: 'user' } }, { message: { role: 'assistant' } }]
    });
    await serverB.close();
    runtimeStoreB.close();
  });
});
