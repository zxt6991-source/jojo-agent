import { describe, expect, it } from 'vitest';
import type { PermissionGate, ToolCall } from '@desktop-agent/contracts';
import { NonInteractivePermissionGate, OrchestrationPermissionGate } from '../src/index.js';

const context = { sessionId: 'session', workingDirectory: '/workspace' };
const call = (name: string, input: unknown = {}): ToolCall => ({ id: 'call', name, input });

describe('orchestration permission gates', () => {
  it('allows orchestration tools and delegates ordinary tools', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner);
    await expect(gate.check(call('sub_agent_start'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('sub_agent_send'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('sub_agent_close'), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('terminal'), context)).resolves.toEqual({ decision: 'deny', reason: 'inner' });
  });

  it('asks once at workflow start when an inline browser recording may run', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner);
    const definition = {
      schemaVersion: 1,
      name: 'browser workflow',
      steps: [{ id: 'replay', type: 'recording', recording: 'export-report' }]
    };

    await expect(gate.check(call('workflow_start', { definition }), context)).resolves.toMatchObject({
      decision: 'ask',
      request: { sessionId: 'session', reason: expect.stringContaining('Browser Recordings') }
    });
    await expect(gate.check(call('workflow_start', {
      definition: 'schemaVersion: 1\nname: browser workflow\nsteps:\n  - id: replay\n    type: recording\n    recording: export-report\n'
    }), context)).resolves.toMatchObject({ decision: 'ask' });
  });

  it('includes the resolved recording effect plan in workflow approval', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner, async () => [
      'Automation plan:',
      '- export-report [project/trusted] domains=reports.example.com effects=click,download'
    ].join('\n'));

    const decision = await gate.check(call('workflow_start', {
      definition: {
        schemaVersion: 1,
        name: 'browser workflow',
        steps: [{ id: 'replay', type: 'recording', recording: 'export-report' }]
      }
    }), context);

    expect(decision).toMatchObject({
      decision: 'ask',
      request: {
        reason: expect.stringContaining('export-report [project/trusted]')
      }
    });
  });

  it('conservatively asks before starting a saved or nested workflow', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner);
    await expect(gate.check(call('workflow_start', { name: 'saved-flow' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('workflow_start', {
      definition: {
        schemaVersion: 1,
        name: 'parent',
        steps: [{ id: 'child', type: 'workflow', name: 'saved-flow' }]
      }
    }), context)).resolves.toMatchObject({ decision: 'ask' });
  });

  it('keeps agent-only inline workflows approval-free', async () => {
    const inner: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'inner' }) };
    const gate = new OrchestrationPermissionGate(inner);
    await expect(gate.check(call('workflow_start', {
      definition: {
        schemaVersion: 1,
        name: 'read only',
        steps: [{ id: 'inspect', type: 'agent', task: 'Inspect the repository' }]
      }
    }), context)).resolves.toEqual({ decision: 'allow' });
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
