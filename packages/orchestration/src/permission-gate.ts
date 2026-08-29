import { WorkflowDefinitionSchema, type PermissionDecision, type PermissionGate, type ToolCall } from '@desktop-agent/contracts';
import { parse as parseYaml } from 'yaml';

export const ORCHESTRATION_TOOL_NAMES = new Set([
  'sub_agent_start',
  'sub_agent_wait',
  'sub_agent_status',
  'sub_agent_cancel',
  'sub_agent_send',
  'sub_agent_close',
  'team_list',
  'team_status',
  'team_delegate',
  'team_wait',
  'team_send',
  'team_inbox',
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
  constructor(
    private readonly inner: PermissionGate,
    private readonly describeBrowserWorkflow?: (call: ToolCall, context: PermissionContext) => Promise<string | undefined>
  ) {}

  async check(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
    if (call.name === 'workflow_start' && workflowMayUseBrowser(call.input)) {
      const detail = await this.describeBrowserWorkflow?.(call, context).catch(() => undefined);
      return {
        decision: 'ask',
        request: {
          requestId: crypto.randomUUID(),
          sessionId: context.sessionId,
          call,
          reason: 'Start a workflow that may replay approved Browser Recordings and produce external effects'
            + (detail ? `\n${detail}` : '')
        }
      };
    }
    if (ORCHESTRATION_TOOL_NAMES.has(call.name)) return { decision: 'allow' };
    return this.inner.check(call, context);
  }
}

function workflowMayUseBrowser(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const value = input as { name?: unknown; definition?: unknown };
  if (typeof value.name === 'string') return true;
  let definition: unknown = value.definition;
  if (typeof definition === 'string') {
    try { definition = parseYaml(definition, { maxAliasCount: 0 }); }
    catch { return false; }
  }
  const parsed = WorkflowDefinitionSchema.safeParse(definition);
  return parsed.success && parsed.data.steps.some((step) => step.type === 'recording' || step.type === 'workflow');
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
