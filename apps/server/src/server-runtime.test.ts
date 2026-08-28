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
});
