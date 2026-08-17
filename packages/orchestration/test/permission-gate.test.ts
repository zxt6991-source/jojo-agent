import { describe, expect, it } from 'vitest';
import type { PermissionGate, ToolCall } from '@desktop-agent/contracts';
import { NonInteractivePermissionGate, OrchestrationPermissionGate } from '../src/index.js';

const context = { sessionId: 'session', workingDirectory: '/workspace' };
const call = (name: string): ToolCall => ({ id: 'call', name, input: {} });

describe('orchestration permission gates', () => {
  it('allows orchestration tools and delegates ordinary tools', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner);
    await expect(gate.check(call('sub_agent_start'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('sub_agent_send'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('sub_agent_close'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('terminal'), context)).resolves.toEqual({ decision: 'deny', reason: 'inner' });
  });

  it('turns interactive approval into a structured denial', async () => {
    const inner: PermissionGate = {
      check: async (toolCall) => ({
        decision: 'ask',
        request: { requestId: 'request', sessionId: 'session', call: toolCall, reason: 'approval' }
      })
    };
    const gate = new NonInteractivePermissionGate(inner);
    await expect(gate.check(call('read_file'), context)).resolves.toMatchObject({
      decision: 'deny', code: 'subagent_requires_approval'
    });
  });

  it('allows workspace-bounded mutations that the inner gate already previewed', async () => {
    const inner: PermissionGate = {
      check: async (toolCall) => ({
        decision: 'ask',
        request: { requestId: 'request', sessionId: 'session', call: toolCall, reason: 'approval' }
      })
    };
    const gate = new NonInteractivePermissionGate(inner);
    await expect(gate.check(call('write_file'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('edit_file'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('delete_file'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('terminal'), context)).resolves.toEqual({ decision: 'allow' });
  });
});
