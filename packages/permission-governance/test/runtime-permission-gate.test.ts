import { describe, expect, it, vi } from 'vitest';
import type { RuntimePermissionGate } from '@desktop-agent/agent-runtime';
import {
  GovernanceRuntimePermissionGate,
  MemoryPermissionAuditSink,
  PermissionGovernanceEngine,
  StaticPermissionPolicyStore
} from '../src/index.js';

const runtimeContext = {
  sessionId: 's1', laneId: 'main', runId: 'r1', providerId: 'p', model: 'm', workingDirectory: '/workspace',
  executionScope: { kind: 'workspace' as const, workingDirectory: '/workspace' }, actor: { kind: 'main' as const }
};

describe('GovernanceRuntimePermissionGate', () => {
  it('always calls the baseline gate before applying a matching grant', async () => {
    const check = vi.fn<RuntimePermissionGate['check']>(async () => ({ decision: 'deny', reason: 'hard boundary', code: 'permission_denied' }));
    const gate = new GovernanceRuntimePermissionGate(
      { check },
      new PermissionGovernanceEngine({ policyStore: new StaticPermissionPolicyStore({ mode: 'yolo', globalRules: [], workspaceRules: [] }) })
    );
    await expect(gate.check({ id: 'c1', name: 'write_file', input: { path: '../x' } }, runtimeContext)).resolves.toEqual({
      decision: 'deny', reason: 'hard boundary', code: 'permission_denied'
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('adds explainable governance metadata without storing raw call input in audit facts', async () => {
    const audit = new MemoryPermissionAuditSink();
    const baseline: RuntimePermissionGate = { check: async (call, context) => ({
      decision: 'ask',
      request: { requestId: 'a1', sessionId: context.sessionId, call, reason: 'Run a local command', security: {
        kind: 'terminal', command: 'pnpm', argumentsPreview: ['test'], cwd: '.', risk: 'medium',
        sandbox: 'strong', network: 'none', secretEnv: [], capabilities: [], reasons: []
      } }
    }) };
    const gate = new GovernanceRuntimePermissionGate(baseline, new PermissionGovernanceEngine(), undefined, audit);
    const result = await gate.check({ id: 'c1', name: 'terminal', input: { command: 'pnpm', args: ['test', '--token=visible-secret'] } }, runtimeContext);
    expect(result).toMatchObject({
      decision: 'ask',
      request: {
        governance: { source: 'baseline', reasonCode: 'baseline_ask', risk: 'medium', locked: false },
        grant: { options: ['once', 'similar', 'conversation'] }
      }
    });
    expect(audit.records).toHaveLength(1);
    expect(JSON.stringify(audit.records[0]?.request.facts)).not.toContain('visible-secret');
  });

  it('offers only a one-time approval for mandatory decisions', async () => {
    const call = { id: 'c1', name: 'install_skill', input: { url: 'https://example.com/skill' } };
    const baseline: RuntimePermissionGate = { check: async () => ({
      decision: 'ask', request: { requestId: 'a1', sessionId: 's1', call, reason: 'Install Skill' }
    }) };
    const gate = new GovernanceRuntimePermissionGate(
      baseline,
      new PermissionGovernanceEngine({ policyStore: new StaticPermissionPolicyStore({ mode: 'yolo', globalRules: [], workspaceRules: [] }) })
    );
    await expect(gate.check(call, runtimeContext)).resolves.toMatchObject({
      decision: 'ask', request: { governance: { source: 'mandatory_approval', locked: true }, grant: { options: ['once'] } }
    });
  });

  it('treats an explicit scheduler trigger as non-interactive', async () => {
    const audit = new MemoryPermissionAuditSink();
    const gate = new GovernanceRuntimePermissionGate(
      { check: async () => ({ decision: 'allow' }) },
      new PermissionGovernanceEngine(),
      undefined,
      audit
    );
    await gate.check(
      { id: 'c1', name: 'read_file', input: { path: 'README.md' } },
      { ...runtimeContext, trigger: { kind: 'scheduler', id: 'sr_1' } }
    );
    expect(audit.records[0]?.request.context).toMatchObject({
      trigger: { kind: 'scheduler' },
      interactive: false
    });
  });
});
