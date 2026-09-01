import { describe, expect, it, vi } from 'vitest';
import type { PermissionGate } from '@desktop-agent/contracts';
import { ChannelPermissionGate } from '../src/index.js';

describe('ChannelPermissionGate', () => {
  it('allows target discovery and requires approval for outbound messages', async () => {
    const check: PermissionGate['check'] = vi.fn(async () => ({ decision: 'deny' as const, reason: 'unknown' }));
    const inner: PermissionGate = { check };
    const gate = new ChannelPermissionGate(inner);
    const context = { sessionId: 'session-1', workingDirectory: '/tmp/workspace' };

    await expect(gate.check({ id: 'list-1', name: 'channel_list_targets', input: {} }, context))
      .resolves.toEqual({ decision: 'allow' });
    await expect(gate.check({
      id: 'send-1', name: 'channel_send', input: { target: { bindingId: 'binding-1' }, text: 'hello' }
    }, context)).resolves.toMatchObject({
      decision: 'ask',
      request: { sessionId: 'session-1', call: { name: 'channel_send' } }
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('delegates unrelated tools to the existing permission chain', async () => {
    const check: PermissionGate['check'] = vi.fn(async () => ({ decision: 'allow' as const }));
    const inner: PermissionGate = { check };
    const gate = new ChannelPermissionGate(inner);
    const call = { id: 'read-1', name: 'read_file', input: { path: 'README.md' } };
    const context = { sessionId: 'session-1', workingDirectory: '/tmp/workspace' };

    await expect(gate.check(call, context)).resolves.toEqual({ decision: 'allow' });
    expect(check).toHaveBeenCalledWith(call, context);
  });
});
