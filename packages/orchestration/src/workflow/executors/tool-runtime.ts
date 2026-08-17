import type { PermissionGate, Tool } from '@desktop-agent/contracts';
import { WORKFLOW_TOOL_STEP_ALLOWLIST } from './tool-step.js';
import type { WorkflowToolRuntime } from './types.js';

export function createWorkflowToolRuntime(options: {
  tools: Iterable<Tool>;
  permissionGate: PermissionGate;
}): WorkflowToolRuntime {
  const tools = new Map([...options.tools].map((tool) => [tool.definition.name, tool]));
  return {
    has(name) {
      return WORKFLOW_TOOL_STEP_ALLOWLIST.has(name) && tools.has(name);
    },
    async execute(invocation) {
      if (!WORKFLOW_TOOL_STEP_ALLOWLIST.has(invocation.name)) {
        return { ok: false, content: `Workflow tool steps cannot call ${invocation.name}.`, code: 'tool_not_allowed' };
      }
      const tool = tools.get(invocation.name);
      if (!tool) {
        return { ok: false, content: `Workflow tool is not registered: ${invocation.name}`, code: 'tool_not_allowed' };
      }
      const call = { id: `wf_tool_${crypto.randomUUID()}`, name: invocation.name, input: invocation.input };
      const decision = await options.permissionGate.check(call, {
        sessionId: invocation.sessionId,
        workingDirectory: invocation.workingDirectory
      });
      if (decision.decision !== 'allow') {
        const reason = decision.decision === 'deny'
          ? decision.reason
          : 'This operation requires interactive approval and is unavailable to a workflow tool step.';
        const code = decision.decision === 'deny' && decision.code === 'tool_not_allowed'
          ? 'tool_not_allowed'
          : 'permission_denied';
        return { ok: false, content: reason, code };
      }
      try {
        const result = await tool.execute(invocation.input, {
          sessionId: invocation.sessionId,
          workingDirectory: invocation.workingDirectory,
          signal: invocation.signal,
          approved: false,
          onProgress: () => undefined
        });
        return {
          ok: result.ok,
          content: result.content,
          ...(result.code ? { code: result.code } : {})
        };
      } catch (error) {
        if (invocation.signal.aborted) throw error;
        return {
          ok: false,
          content: error instanceof Error ? error.message : String(error),
          code: 'workflow_step_failed'
        };
      }
    }
  };
}
