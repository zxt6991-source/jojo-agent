import { OrchestrationError } from '../../errors.js';
import { WRITE_CAPABLE_AGENT_TOOLS } from '../../subagent/tool-policy.js';
import { assertOutputSchema, validateStructuredOutput } from '../../structured-output.js';
import { emptyUsage } from '../../usage.js';
import { mergeWorkflowToolInput } from '../data/inputs.js';
import type {
  WorkflowStepExecutionContext,
  WorkflowStepExecutionResult,
  WorkflowStepExecutor,
  WorkflowToolRuntime
} from './types.js';

export const WORKFLOW_TOOL_STEP_ALLOWLIST = new Set([
  'read_file',
  'list_files',
  'grep',
  'glob',
  'web_search',
  'web_fetch'
]);

export class ToolStepExecutor implements WorkflowStepExecutor {
  readonly type = 'tool' as const;
  readonly usesAgentScheduler = false;

  constructor(private readonly toolRuntime?: WorkflowToolRuntime) {}

  async execute(context: WorkflowStepExecutionContext): Promise<WorkflowStepExecutionResult> {
    const step = context.step;
    if (step.type !== 'tool') {
      throw new OrchestrationError('workflow_step_type_unsupported', `Tool executor cannot run step type: ${step.type}`);
    }
    if (!WORKFLOW_TOOL_STEP_ALLOWLIST.has(step.tool) || WRITE_CAPABLE_AGENT_TOOLS.has(step.tool)) {
      throw new OrchestrationError('tool_not_allowed', `Workflow tool steps cannot call ${step.tool}.`);
    }
    if (!this.toolRuntime) {
      throw new OrchestrationError('tool_not_allowed', 'Workflow tool runtime is not configured.');
    }
    if (!this.toolRuntime.has(step.tool)) {
      throw new OrchestrationError('tool_not_allowed', `Workflow tool is not registered: ${step.tool}`);
    }
    if (step.outputSchema) assertOutputSchema(step.outputSchema);
    const input = mergeWorkflowToolInput(step.input, context.resolvedInputs);
    context.log('info', `Invoking ${step.tool}.`);
    const invocation = await this.toolRuntime.execute({
      name: step.tool,
      input,
      sessionId: context.request.sessionId,
      workingDirectory: context.request.workingDirectory,
      signal: context.signal
    });
    if (context.signal.aborted) {
      return {
        output: invocation.content,
        stopReason: 'cancelled',
        usage: emptyUsage(),
        incomplete: true
      };
    }
    if (!invocation.ok) {
      const errorCode = invocation.code === 'permission_denied' || invocation.code === 'tool_not_allowed'
        ? invocation.code
        : 'workflow_step_failed';
      return {
        output: invocation.content,
        stopReason: errorCode,
        errorCode,
        error: invocation.content,
        usage: emptyUsage(),
        incomplete: true
      };
    }
    const result: WorkflowStepExecutionResult = {
      output: invocation.content,
      stopReason: 'completed',
      usage: emptyUsage(),
      incomplete: false
    };
    if (step.outputSchema) {
      const structured = validateStructuredOutput(invocation.content, step.outputSchema);
      if (!structured.ok) {
        result.stopReason = structured.code;
        result.errorCode = structured.code;
        result.error = structured.message;
        result.schemaValid = false;
        result.incomplete = true;
        return result;
      }
      result.structuredResult = structuredClone(structured.value);
      result.schemaValid = true;
    }
    return result;
  }
}
