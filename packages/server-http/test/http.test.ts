import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate } from '@desktop-agent/contracts';
import { createJojoRuntime } from '@desktop-agent/runtime-composition';
import { createJojoAppService } from '@desktop-agent/app-service';
import { createJojoServerCore } from '@desktop-agent/server-core';
import { createJojoHttpServer } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

describe('HTTP server adapter', () => {
  it('authenticates and validates session resources without exposing runtime internals', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' },
      providers: { resolve: () => new ScriptedProvider([]) },
      permissions: allow
    });
    const core = createJojoServerCore(createJojoAppService(runtime), { serverId: 'http-test' });
    const server = await createJojoHttpServer(core, { token: 'secret-token' });

    expect((await server.app.inject({ method: 'GET', url: '/api/v1/server' })).statusCode).toBe(401);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: 'Bearer secret-token', 'idempotency-key': 'create-http' },
      payload: { id: 'http-session', executionScope: { kind: 'none' } }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'http-session', lease: null });

    const invalid = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: 'Bearer secret-token' },
      payload: { executionScope: { kind: 'none' }, unexpected: true }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_request' } });
    await server.close();
  });

  it('forwards unauthenticated channel webhooks with their exact raw JSON bytes', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' }, providers: { resolve: () => new ScriptedProvider([]) }, permissions: allow
    });
    const core = createJojoServerCore(createJojoAppService(runtime), { serverId: 'webhook-test' });
    const received: Array<{ instanceId: string; rawBody?: string | Uint8Array; authorization?: string }> = [];
    const server = await createJojoHttpServer(core, {
      token: 'admin-token',
      channelWebhook: {
        handleWebhook: async (instanceId, request) => {
          received.push({
            instanceId,
            ...(request.rawBody !== undefined ? { rawBody: request.rawBody } : {}),
            ...(request.headers.authorization ? { authorization: request.headers.authorization } : {})
          });
          return { status: 202, headers: { 'x-channel-result': 'accepted' }, body: { ok: true } };
        }
      }
    });
    const raw = '{ "token": "verification", "nested": {"value": 1} }';
    const response = await server.app.inject({
      method: 'POST', url: '/api/v1/channels/webhook/feishu-work',
      headers: { 'content-type': 'application/json', 'x-lark-signature': 'signature' }, payload: raw
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers['x-channel-result']).toBe('accepted');
    expect(response.json()).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ instanceId: 'feishu-work' });
    expect(Buffer.from(received[0]!.rawBody!).toString('utf8')).toBe(raw);
    expect(received[0]?.authorization).toBeUndefined();
    await server.close();
  });

  it('emits one structured completion record with the request id and no request body', async () => {
    const runtime = await createJojoRuntime({
      host: { kind: 'server' }, providers: { resolve: () => new ScriptedProvider([]) }, permissions: allow
    });
    const core = createJojoServerCore(createJojoAppService(runtime), { serverId: 'logging-test' });
    const records: unknown[] = [];
    const logger = createRecordingLogger(records);
    const server = await createJojoHttpServer(core, { logger });
    const response = await server.app.inject({
      method: 'GET', url: '/healthz', headers: { 'x-request-id': 'request-log-test' }
    });
    expect(response.statusCode).toBe(200);
    expect(records).toContainEqual(expect.objectContaining({
      event: 'http.request.completed',
      requestId: 'request-log-test',
      method: 'GET',
      route: '/healthz',
      statusCode: 200
    }));
    expect(JSON.stringify(records)).not.toContain('headers');
    expect(JSON.stringify(records)).not.toContain('body');
    await server.close();
  });
});

function createRecordingLogger(records: unknown[]): FastifyBaseLogger {
  const record = (value: unknown) => records.push(value);
  const logger = {
    level: 'info',
    info: record,
    error: record,
    debug: record,
    fatal: record,
    warn: record,
    trace: record,
    silent: record,
    child: () => logger
  };
  return logger as FastifyBaseLogger;
}
