import { describe, expect, it } from 'vitest';
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
});
