import { describe, expect, it } from 'vitest';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { PermissionDecision, ToolCall } from '@desktop-agent/contracts';
import {
  BackgroundAgentPermissionPolicyStore,
  DefaultPermissionRequestNormalizer,
  MemoryPermissionGrantStore,
  PermissionGovernanceEngine,
  StaticPermissionPolicyStore,
  type GovernanceRequest,
  type PermissionMode,
  type ResolvedPermissionPolicy
} from '../src/index.js';

const normalizer = new DefaultPermissionRequestNormalizer();

function context(actor: RuntimeResolutionContext['actor'] = { kind: 'main' }): RuntimeResolutionContext {
  return {
    sessionId: 'session-1', laneId: 'main', runId: 'run-1', providerId: 'test', model: 'test',
    executionScope: { kind: 'workspace', workingDirectory: '/workspace' },
    workingDirectory: '/workspace', actor
  };
}

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `${name}-1`, name, input };
}

function approval(toolCall: ToolCall, security?: NonNullable<Extract<PermissionDecision, { decision: 'ask' }>['request']['security']>): PermissionDecision {
  return {
    decision: 'ask',
    request: {
      requestId: `approval-${toolCall.id}`, sessionId: 'session-1', call: toolCall, reason: 'Baseline approval',
      ...(security ? { security } : {})
    }
  };
}

function terminalApproval(toolCall: ToolCall, options: {
  risk?: 'medium' | 'high' | 'critical'; network?: 'none' | 'host'; secretEnv?: string[]; sandbox?: 'strong' | 'container' | 'soft' | 'none';
} = {}): PermissionDecision {
  return approval(toolCall, {
    kind: 'terminal', command: String((toolCall.input as Record<string, unknown>).command ?? 'pnpm'),
    argumentsPreview: ['test'], cwd: '.', risk: options.risk ?? 'medium',
    sandbox: options.sandbox ?? 'strong', network: options.network ?? 'none',
    secretEnv: options.secretEnv ?? [], capabilities: ['workspace:read'], reasons: []
  });
}

function policy(mode: PermissionMode, overrides: Partial<ResolvedPermissionPolicy> = {}): StaticPermissionPolicyStore {
  return new StaticPermissionPolicyStore({ mode, globalRules: [], workspaceRules: [], ...overrides });
}

async function request(toolCall: ToolCall, baseline: PermissionDecision, actor?: RuntimeResolutionContext['actor']): Promise<GovernanceRequest> {
  return normalizer.normalize({ call: toolCall, context: context(actor), baseline });
}

describe('PermissionGovernanceEngine', () => {
  it.each(['ask', 'auto', 'yolo'] as const)('never lets %s mode override a baseline deny', async (mode) => {
    const toolCall = call('read_file', { path: '../../secret' });
    const engine = new PermissionGovernanceEngine({ policyStore: policy(mode) });
    const result = await engine.evaluate(await request(toolCall, { decision: 'deny', reason: 'workspace escape', code: 'permission_denied' }));
    expect(result).toMatchObject({ effect: 'deny', locked: true, source: 'security_boundary', reasonCode: 'permission_denied' });
  });

  it('keeps ASK mode behavior identical to the baseline', async () => {
    const engine = new PermissionGovernanceEngine({ policyStore: policy('ask') });
    const allowed = await engine.evaluate(await request(call('read_file', { path: 'README.md' }), { decision: 'allow' }));
    const asked = await engine.evaluate(await request(call('write_file', { path: 'a.ts' }), approval(call('write_file', { path: 'a.ts' }))));
    expect(allowed).toMatchObject({ effect: 'allow', source: 'baseline' });
    expect(asked).toMatchObject({ effect: 'ask', source: 'baseline', locked: false });
  });

  it('AUTO allows prepared workspace writes and a medium isolated terminal', async () => {
    const engine = new PermissionGovernanceEngine({ policyStore: policy('auto') });
    const writeCall = call('write_file', { path: 'src/a.ts' });
    const terminalCall = call('terminal', { command: 'pnpm', args: ['test'], cwd: '.', network: 'none', secretEnv: [] });
    expect(await engine.evaluate(await request(writeCall, approval(writeCall)))).toMatchObject({ effect: 'allow', source: 'mode', reasonCode: 'auto_low_risk' });
    expect(await engine.evaluate(await request(terminalCall, terminalApproval(terminalCall)))).toMatchObject({ effect: 'allow', source: 'mode', reasonCode: 'auto_low_risk' });
  });

  it('AUTO does not approve host network, secrets, high risk, or external effects', async () => {
    const engine = new PermissionGovernanceEngine({ policyStore: policy('auto') });
    for (const options of [
      { network: 'host' as const },
      { secretEnv: ['GITHUB_TOKEN'] },
      { risk: 'high' as const }
    ]) {
      const terminalCall = call('terminal', { command: 'pnpm', args: ['test'], ...options });
      expect(await engine.evaluate(await request(terminalCall, terminalApproval(terminalCall, options)))).toMatchObject({ effect: 'ask' });
    }
    const mcpCall = call('mcp__issues__create', { title: 'bug' });
    expect(await engine.evaluate(await request(mcpCall, approval(mcpCall, {
      kind: 'mcp', serverId: 'issues', serverName: 'Issues', toolName: 'create',
      risk: 'external_side_effect', capabilities: [], reasons: []
    })))).toMatchObject({ effect: 'ask' });
  });

  it('YOLO removes ordinary approval but preserves mandatory approval', async () => {
    const engine = new PermissionGovernanceEngine({ policyStore: policy('yolo') });
    const networkCall = call('terminal', { command: 'curl', args: ['https://example.com'], network: 'host' });
    expect(await engine.evaluate(await request(networkCall, terminalApproval(networkCall, { risk: 'high', network: 'host' })))).toMatchObject({ effect: 'allow', source: 'mode' });

    const secretCall = call('terminal', { command: 'curl', network: 'host', secretEnv: ['TOKEN'] });
    expect(await engine.evaluate(await request(secretCall, terminalApproval(secretCall, { risk: 'high', network: 'host', secretEnv: ['TOKEN'] })))).toMatchObject({
      effect: 'ask', locked: true, source: 'mandatory_approval', reasonCode: 'network_and_secret_requires_confirmation'
    });
    const outside = call('read_file', { path: '/etc/hosts' });
    expect(await engine.evaluate(await request(outside, approval(outside)))).toMatchObject({ effect: 'ask', locked: true });
  });

  it('a grant cannot bypass deny or expand network, secrets, or actor', async () => {
    const grants = new MemoryPermissionGrantStore();
    const engine = new PermissionGovernanceEngine({ policyStore: policy('ask'), grantStore: grants });
    const initialCall = call('terminal', { command: 'pnpm', args: ['test'], cwd: '.', network: 'none', secretEnv: [] });
    const initial = await request(initialCall, terminalApproval(initialCall));
    await engine.evaluate(initial);
    grants.grant(initial, 'conversation');

    expect(await engine.evaluate(await request(initialCall, { decision: 'deny', reason: 'sandbox unavailable' }))).toMatchObject({ effect: 'deny', locked: true });

    const networkCall = call('terminal', { command: 'pnpm', args: ['test'], cwd: '.', network: 'host', secretEnv: [] });
    expect(await engine.evaluate(await request(networkCall, terminalApproval(networkCall, { risk: 'high', network: 'host' })))).toMatchObject({ effect: 'ask' });

    const secretCall = call('terminal', { command: 'pnpm', args: ['test'], cwd: '.', network: 'none', secretEnv: ['TOKEN'] });
    expect(await engine.evaluate(await request(secretCall, terminalApproval(secretCall, { risk: 'high', secretEnv: ['TOKEN'] })))).toMatchObject({ effect: 'ask' });

    expect(await engine.evaluate(await request(initialCall, terminalApproval(initialCall), { kind: 'subagent', id: 'agent-1' }))).toMatchObject({ effect: 'ask' });
  });

  it('binds remembered approval requests to the originating session', async () => {
    const grants = new MemoryPermissionGrantStore();
    const toolCall = call('write_file', { path: 'a.ts' });
    const first = await request(toolCall, approval(toolCall));
    const second: GovernanceRequest = {
      ...first,
      context: { ...first.context, sessionId: 'session-2' }
    };
    grants.remember(first);
    grants.remember(second);
    expect(grants.grantApproval('session-1', first.fingerprint, 'conversation')).toBe(true);
    expect(grants.find(first)).toBeDefined();
    expect(grants.find(second)).toBeUndefined();
  });

  it('explicit deny wins globally and explicit ask cannot be removed by a grant', async () => {
    const toolCall = call('write_file', { path: 'a.ts' });
    const baseline = approval(toolCall);
    const grants = new MemoryPermissionGrantStore();
    const normalized = await request(toolCall, baseline);
    grants.grant(normalized, 'conversation');
    const denyEngine = new PermissionGovernanceEngine({
      grantStore: grants,
      policyStore: policy('yolo', { globalRules: [{ id: 'deny-write', effect: 'deny', match: { operations: ['write'] } }] })
    });
    expect(await denyEngine.evaluate(normalized)).toMatchObject({ effect: 'deny', source: 'user_policy', policyRuleId: 'deny-write' });

    const askEngine = new PermissionGovernanceEngine({
      grantStore: grants,
      policyStore: policy('yolo', { workspaceRules: [{ id: 'ask-write', effect: 'ask', match: { tools: ['write_file'] } }] })
    });
    expect(await askEngine.evaluate(normalized)).toMatchObject({ effect: 'ask', source: 'user_policy', policyRuleId: 'ask-write' });
  });

  it('applies narrow background-agent defaults after user policy', async () => {
    const backgroundPolicy = new BackgroundAgentPermissionPolicyStore(policy('ask'));
    const engine = new PermissionGovernanceEngine({ policyStore: backgroundPolicy });
    const writeCall = call('write_file', { path: 'src/a.ts' });
    const terminalCall = call('terminal', { command: 'pnpm', args: ['test'], cwd: '.', network: 'none', secretEnv: [] });

    expect(await engine.evaluate(await request(writeCall, approval(writeCall), { kind: 'subagent', id: 'agent-1' })))
      .toMatchObject({ effect: 'allow', policyRuleId: 'builtin-background-workspace-write' });
    expect(await engine.evaluate(await request(terminalCall, terminalApproval(terminalCall), { kind: 'workflow', id: 'workflow-1' })))
      .toMatchObject({ effect: 'allow', policyRuleId: 'builtin-background-isolated-terminal' });
    expect(await engine.evaluate(await request(writeCall, approval(writeCall), { kind: 'main' })))
      .toMatchObject({ effect: 'ask', source: 'baseline' });
  });

  it('lets user ASK and DENY rules tighten background-agent defaults', async () => {
    const askStore = new BackgroundAgentPermissionPolicyStore(policy('ask', {
      workspaceRules: [{ id: 'confirm-agent-write', effect: 'ask', match: { actors: ['subagent'], operations: ['write'] } }]
    }));
    const denyStore = new BackgroundAgentPermissionPolicyStore(policy('ask', {
      globalRules: [{ id: 'deny-agent-write', effect: 'deny', match: { actors: ['subagent'], operations: ['write'] } }]
    }));
    const writeCall = call('write_file', { path: 'src/a.ts' });
    const normalized = await request(writeCall, approval(writeCall), { kind: 'subagent', id: 'agent-1' });

    expect(await new PermissionGovernanceEngine({ policyStore: askStore }).evaluate(normalized))
      .toMatchObject({ effect: 'ask', policyRuleId: 'confirm-agent-write' });
    expect(await new PermissionGovernanceEngine({ policyStore: denyStore }).evaluate(normalized))
      .toMatchObject({ effect: 'deny', policyRuleId: 'deny-agent-write' });
  });
});
