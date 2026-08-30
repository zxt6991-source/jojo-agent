import { describe, expect, it } from 'vitest';
import type { PermissionGate, ToolCall } from '@desktop-agent/contracts';
import { SchedulerPermissionGate } from '../src/index.js';

const context = { sessionId: 'session', workingDirectory: '/workspace' };
const call = (name: string): ToolCall => ({ id: 'call', name, input: {} });

describe('SchedulerPermissionGate', () => {
  it('allows scheduler tools and delegates unrelated tools', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new SchedulerPermissionGate(inner);

    await expect(gate.check(call('schedule_create'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('schedule_runs'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('unknown_xyz'), context)).resolves.toEqual({ decision: 'deny', reason: 'inner' });
  });
});
