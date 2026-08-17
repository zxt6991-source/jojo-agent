import type { PermissionDecision, PermissionGate, ToolCall } from '@desktop-agent/contracts';

export const ORCHESTRATION_TOOL_NAMES = new Set([
  'sub_agent_start',
  'sub_agent_wait',
  'sub_agent_status',
  'sub_agent_cancel',
  'sub_agent_send',
  'sub_agent_close',
  'workflow_start',
  'workflow_wait',
  'workflow_status',
  'workflow_cancel',
  'workflow_resume',
  'workflow_list'
]);

const WORKSPACE_BOUNDED_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'terminal']);

type PermissionContext = { sessionId: string; workingDirectory: string };

export class OrchestrationPermissionGate implements PermissionGate {
  constructor(private readonly inner: PermissionGate) {}

  check(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
    if (ORCHESTRATION_TOOL_NAMES.has(call.name)) return Promise.resolve({ decision: 'allow' });
    return this.inner.check(call, context);
  }
}

export class NonInteractivePermissionGate implements PermissionGate {
  constructor(private readonly inner: PermissionGate) {}

  async check(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
    const decision = await this.inner.check(call, context);
    if (decision.decision !== 'ask') return decision;
    if (WORKSPACE_BOUNDED_MUTATION_TOOLS.has(call.name)) return { decision: 'allow' };
    return {
      decision: 'deny',
      code: 'subagent_requires_approval',
      reason: 'This operation requires interactive approval and is unavailable to a background sub-agent.'
    };
  }
}
