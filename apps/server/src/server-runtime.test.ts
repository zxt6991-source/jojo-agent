import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type {
  ChannelAdapterContext,
  ChannelInstance,
  ChannelWebhookRequest,
  ChannelWebhookResponse
} from '@desktop-agent/channel-core';
import { FakeChannelAdapter } from '@desktop-agent/channel-core/testing';
import { MemoryChannelStore } from '@desktop-agent/channel-runtime';
import type { PermissionGate } from '@desktop-agent/contracts';
import type { RequestContext } from '@desktop-agent/server-protocol';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import { createHeadlessServer, createNetworkServer } from './index.js';

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
  it('composes channel lifecycle and exposes its webhook through the network server', async () => {
    const store = new MemoryChannelStore();
    const timestamp = new Date().toISOString();
    const channelInstance: ChannelInstance = {
      id: 'webhook-instance', kind: 'webhook-test', name: 'Webhook Test', enabled: true,
      config: {}, secretRefs: {}, revision: 1, fingerprint: 'fp', createdAt: timestamp, updatedAt: timestamp
    };
    await store.saveInstance(channelInstance);
    let starts = 0;
    let stops = 0;
    let webhook: ChannelWebhookRequest | undefined;
    class WebhookAdapter extends FakeChannelAdapter {
      override async start(channelContext: ChannelAdapterContext): Promise<void> {
        starts += 1;
        await super.start(channelContext);
      }
      override async stop(): Promise<void> {
        stops += 1;
        await super.stop();
      }
      async handleWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
        webhook = request;
        return { status: 200, body: { accepted: true } };
      }
    }
    const adapter = new WebhookAdapter('webhook-test', channelInstance.id);
    const server = await createNetworkServer({
      providers: { resolve: () => new ScriptedProvider([]) }, permissions: allow,
      channels: {
        store, builtInAdapters: false, defaultProviderId: 'test', defaultModel: 'scripted',
        secrets: { resolve: async () => 'secret' },
        factories: [{ kind: 'webhook-test', create: async () => adapter }]
      },
      http: { token: 'admin-token' }
    });
    expect(starts).toBe(1);
    expect(server.channelManager).toBeDefined();
    const response = await server.http.app.inject({
      method: 'POST', url: '/api/v1/channels/webhook/webhook-instance',
      headers: { 'content-type': 'application/json' }, payload: '{"event":"test"}'
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(Buffer.from(webhook!.rawBody!).toString('utf8')).toBe('{"event":"test"}');

    const authorization = { authorization: 'Bearer admin-token' };
    const capabilities = await server.http.app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: authorization });
    expect(capabilities.json()).toMatchObject({
      channels: { enabled: true, kinds: ['webhook-test'], inbound: true, outbound: true, approvals: true }
    });
    const listed = await server.http.app.inject({ method: 'GET', url: '/api/v1/channels', headers: authorization });
    expect(listed.json()).toMatchObject([{ id: 'webhook-instance', kind: 'webhook-test', revision: 1 }]);
    await expect(server.core.listChannelInstances({
      requestId: 'channel-read', principal: { id: 'reader', type: 'token', scopes: ['channels:read'] }
    })).resolves.toHaveLength(1);
    expect(() => server.core.createChannelInstance({
      requestId: 'channel-write', principal: { id: 'reader', type: 'token', scopes: ['channels:read'] }
    }, { id: 'forbidden', kind: 'webhook-test', name: 'Forbidden', enabled: false, config: {}, secretRefs: {} }))
      .toThrow('channels:write');

    const createdInstance = await server.http.app.inject({
      method: 'POST', url: '/api/v1/channels', headers: { ...authorization, 'idempotency-key': 'instance-create' },
      payload: { id: 'disabled-instance', kind: 'webhook-test', name: 'Disabled', enabled: false, config: {}, secretRefs: {} }
    });
    expect(createdInstance.statusCode).toBe(201);
    expect(createdInstance.json()).toMatchObject({ id: 'disabled-instance', enabled: false, revision: 1 });
    const updatedInstance = await server.http.app.inject({
      method: 'PATCH', url: '/api/v1/channels/disabled-instance', headers: authorization,
      payload: { name: 'Disabled Updated', expectedRevision: 1 }
    });
    expect(updatedInstance.json()).toMatchObject({ name: 'Disabled Updated', revision: 2 });
    expect((await server.http.app.inject({
      method: 'DELETE', url: '/api/v1/channels/disabled-instance?expectedRevision=2', headers: authorization
    })).statusCode).toBe(204);

    const createdBinding = await server.http.app.inject({
      method: 'POST', url: '/api/v1/channel-bindings', headers: { ...authorization, 'idempotency-key': 'binding-create' },
      payload: {
        id: 'binding-test', instanceId: 'webhook-instance', conversation: { id: 'chat-test', type: 'direct' },
        routing: { sessionMode: 'persistent' },
        policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false }
      }
    });
    expect(createdBinding.statusCode).toBe(201);
    expect(createdBinding.json()).toMatchObject({ id: 'binding-test', revision: 1 });
    const tested = await server.http.app.inject({
      method: 'POST', url: '/api/v1/channels/webhook-instance/test',
      headers: { ...authorization, 'idempotency-key': 'channel-test' }, payload: { bindingId: 'binding-test', text: 'test delivery' }
    });
    expect(tested.statusCode).toBe(202);
    expect(tested.json()).toMatchObject({ status: 'delivered' });
    expect(adapter.sent.at(-1)?.content).toEqual([{ type: 'text', text: 'test delivery' }]);
    const deliveries = await server.http.app.inject({ method: 'GET', url: '/api/v1/channel-deliveries', headers: authorization });
    expect(deliveries.json()).toMatchObject([{
      instanceId: 'webhook-instance', bindingId: 'binding-test', status: 'delivered', mode: 'system'
    }]);
    expect(deliveries.json()[0]).not.toHaveProperty('request');
    const health = await server.http.app.inject({ method: 'GET', url: '/api/v1/channel-health', headers: authorization });
    expect(health.json()).toMatchObject([{ instanceId: 'webhook-instance', status: 'connected' }]);

    const conflict = await server.http.app.inject({
      method: 'DELETE', url: '/api/v1/channels/webhook-instance?expectedRevision=1', headers: authorization
    });
    expect(conflict.statusCode).toBe(409);
    expect((await server.http.app.inject({
      method: 'DELETE', url: '/api/v1/channel-bindings/binding-test?expectedRevision=1', headers: authorization
    })).statusCode).toBe(204);
    expect((await server.http.app.inject({
      method: 'DELETE', url: '/api/v1/channels/webhook-instance?expectedRevision=1', headers: authorization
    })).statusCode).toBe(204);
    await server.close();
    expect(stops).toBe(1);
  });

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

  it('runs Agent schedules through scoped control-plane methods without a session lease', async () => {
    const server = await createHeadlessServer({
      providers: { resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'scheduled answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      permissions: allow
    });
    await server.core.createSession(context, { id: 'scheduled-session', executionScope: { kind: 'none' } });
    const writeContext: RequestContext = {
      requestId: 'schedule-write',
      principal: { id: 'automation-editor', type: 'token', scopes: ['schedules:write'] }
    };
    const readContext: RequestContext = {
      requestId: 'schedule-read',
      principal: { id: 'automation-reader', type: 'token', scopes: ['schedules:read'] }
    };
    const runContext: RequestContext = {
      requestId: 'schedule-run',
      principal: { id: 'automation-runner', type: 'token', scopes: ['schedules:run'] }
    };
    const cancelContext: RequestContext = {
      requestId: 'schedule-cancel',
      principal: { id: 'automation-canceller', type: 'token', scopes: ['schedules:cancel'] }
    };
    const input = {
      name: 'Headless Agent',
      enabled: false,
      spec: { kind: 'once' as const, runAt: new Date(Date.now() + 60_000).toISOString() },
      target: {
        kind: 'agent' as const,
        sessionId: 'scheduled-session',
        input: { content: [{ type: 'text' as const, text: 'scheduled prompt' }] },
        providerId: 'test',
        model: 'scripted'
      }
    };
    expect(() => server.core.createSchedule(readContext, input)).toThrow(/schedules:write/u);
    const schedule = await server.core.createSchedule(writeContext, input, 'create-schedule');
    expect(server.core.capabilities.scheduler).toEqual({ enabled: true, targets: ['agent'] });
    await expect(server.core.listSchedules(readContext)).resolves.toMatchObject([{ id: schedule.id }]);

    const started = await server.core.runScheduleNow(runContext, schedule.id, {}, 'run-schedule');
    let terminal = await server.core.getScheduleRun(readContext, started.id);
    for (let attempt = 0; attempt < 40 && terminal.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      terminal = await server.core.getScheduleRun(readContext, started.id);
    }
    expect(terminal).toMatchObject({ status: 'completed', resultPreview: 'scheduled answer' });
    await expect(server.core.cancelScheduleRun(cancelContext, started.id)).resolves.toBeUndefined();
    await server.close();
  });

  it('restores persisted schedules from the headless scheduler database', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-scheduler-restart-'));
    const runtimeFile = path.join(directory, 'runtime.sqlite');
    const runtimeStoreA = new SqliteAgentRuntimeStore(runtimeFile);
    const serverA = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreA,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await serverA.core.createSession(context, { id: 'persisted-schedule-session', executionScope: { kind: 'none' } });
    const schedule = await serverA.core.createSchedule(context, {
      name: 'Persisted automation',
      enabled: false,
      spec: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      target: {
        kind: 'agent',
        sessionId: 'persisted-schedule-session',
        input: { content: [{ type: 'text', text: 'persist me' }] },
        providerId: 'test',
        model: 'scripted'
      }
    });
    await serverA.close();
    runtimeStoreA.close();

    const runtimeStoreB = new SqliteAgentRuntimeStore(runtimeFile);
    const serverB = await createHeadlessServer({
      dataDir: directory,
      store: runtimeStoreB,
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    await expect(serverB.core.getSchedule(context, schedule.id)).resolves.toMatchObject({
      id: schedule.id,
      name: 'Persisted automation',
      enabled: false
    });
    await serverB.close();
    runtimeStoreB.close();
  });
});
