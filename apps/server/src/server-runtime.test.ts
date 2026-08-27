import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { PermissionGate } from '@desktop-agent/contracts';
import { createHeadlessServer } from './index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

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
});
