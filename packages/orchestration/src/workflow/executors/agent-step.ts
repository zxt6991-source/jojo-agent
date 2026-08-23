import type { WorkflowAgentStep } from '@desktop-agent/contracts';
import { OrchestrationError } from '../../errors.js';
import { IsolationManager } from '../../isolation/manager.js';
import { resolveIsolationType, withIsolationTask } from '../../isolation/policy.js';
import type { IsolationContext } from '../../isolation/types.js';
import { AgentProfileRegistry } from '../../subagent/profile-registry.js';
import type { LeafAgentRunner } from '../../subagent/types.js';
import { assertOutputSchema, validateStructuredOutput } from '../../structured-output.js';
import { emptyUsage } from '../../usage.js';
import { buildStepPrompt } from '../prompt-builder.js';
import type { WorkflowStepExecutionContext, WorkflowStepExecutionResult, WorkflowStepExecutor } from './types.js';

export class AgentStepExecutor implements WorkflowStepExecutor {
  readonly type = 'agent' as const;
  readonly usesAgentScheduler = true;

  constructor(
    private readonly runner: LeafAgentRunner,
    private readonly profileRegistry: AgentProfileRegistry,
    private readonly isolation?: IsolationManager
  ) {}

  async execute(context: WorkflowStepExecutionContext): Promise<WorkflowStepExecutionResult> {
    const step = context.step;
    if (step.type !== 'agent') {
      throw new OrchestrationError('workflow_step_type_unsupported', `Agent executor cannot run step type: ${step.type}`);
    }
    if (step.outputSchema) assertOutputSchema(step.outputSchema);
    const model = step.model && step.model !== 'inherit' ? step.model : context.request.model;
    const profile = this.profileRegistry.get(step.profile, context.request.workingDirectory);
    const isolationType = resolveIsolationType({
      profile,
      ...(step.readOnly !== undefined ? { requestReadOnly: step.readOnly } : {}),
      ...(step.isolation?.type ? { requestedType: step.isolation.type } : {})
    });
    let isolationContext: IsolationContext | undefined;
    const result: WorkflowStepExecutionResult = {
      output: '',
      stopReason: 'stop',
      model,
      usage: emptyUsage(),
      incomplete: false
    };
    try {
      if (isolationType === 'worktree') {
        if (!this.isolation) {
          throw new OrchestrationError('worktree_create_failed', 'Worktree isolation is not configured.');
        }
        isolationContext = await this.isolation.prepare({
          ownerId: `${context.request.id}:${step.id}:${context.attempt}`,
          sessionId: context.request.sessionId,
          workingDirectory: context.request.workingDirectory,
          branchHint: `${step.id}-${context.attempt}`
        });
        context.log('info', `Prepared worktree ${isolationContext.branch}.`);
      }
      const run = await this.runner.run({
        id: `${context.request.id}:${step.id}`,
        sessionId: context.request.sessionId,
        workingDirectory: isolationContext?.workingDirectory ?? context.request.workingDirectory,
        task: withIsolationTask(buildStepPrompt(step, context.dependencies, context.resolvedInputs), isolationContext),
        profile: step.profile,
        providerId: context.request.providerId,
        model,
        maxIterations: step.maxIterations ?? 8,
        timeoutMs: step.timeoutMs ?? 120_000,
        runtimeLane: { name: `workflow:${context.request.id}:${step.id}`, parentLane: 'main' },
        ...(context.request.memory ? { memoryBinding: context.request.memory } : {}),
        ...(step.tools ? { tools: step.tools } : {}),
        ...(step.readOnly !== undefined ? { readOnly: step.readOnly } : {}),
        ...(step.outputSchema ? { outputSchema: step.outputSchema } : {})
      }, context.signal, (event) => {
        if (event.type === 'usage') context.onUsage(event);
      });
      result.output = run.result;
      result.stopReason = run.stopReason;
      result.usage = run.usage;
      result.incomplete = run.incomplete;
      if (run.model) result.model = run.model;
      this.applyStructuredOutput(step, result);
    } catch (error) {
      const setup = error instanceof OrchestrationError && (
        error.code === 'invalid_profile'
        || error.code === 'output_schema_invalid'
        || error.code === 'isolation_required'
        || error.code === 'worktree_not_a_git_repository'
        || error.code === 'worktree_create_failed'
        || error.code === 'worktree_path_invalid'
      );
      if (setup && !isolationContext) throw error;
      if (context.signal.aborted) {
        result.stopReason = 'cancelled';
        result.incomplete = true;
        if (error instanceof Error) result.error = error.message;
      } else if (error instanceof OrchestrationError) {
        result.stopReason = error.code;
        result.error = error.message;
        result.incomplete = true;
        if (
          error.code === 'provider_timeout'
          || error.code === 'provider_error'
          || error.code === 'invalid_profile'
          || error.code === 'output_schema_invalid'
          || error.code === 'output_schema_validation_failed'
          || error.code === 'isolation_required'
          || error.code === 'worktree_not_a_git_repository'
          || error.code === 'worktree_create_failed'
          || error.code === 'worktree_path_invalid'
        ) result.errorCode = error.code;
        else result.errorCode = 'workflow_step_failed';
      } else {
        result.stopReason = 'workflow_step_failed';
        result.errorCode = 'workflow_step_failed';
        result.error = error instanceof Error ? error.message : String(error);
        result.incomplete = true;
      }
    } finally {
      if (isolationContext && this.isolation) {
        try {
          result.isolation = await this.isolation.finish(isolationContext);
          if (result.isolation.hasChanges) {
            context.log('info', `Kept reviewable worktree ${result.isolation.branch}; changes are not merged.`);
          }
        } catch (error) {
          context.log('error', error instanceof Error ? error.message : String(error));
        }
      }
    }
    return result;
  }

  private applyStructuredOutput(step: WorkflowAgentStep, result: WorkflowStepExecutionResult): void {
    if (!step.outputSchema || result.stopReason === 'cancelled') return;
    const structured = validateStructuredOutput(result.output, step.outputSchema);
    if (!structured.ok) {
      result.stopReason = structured.code;
      result.errorCode = structured.code;
      result.error = structured.message;
      result.schemaValid = false;
      result.incomplete = true;
      return;
    }
    result.structuredResult = structuredClone(structured.value);
    result.schemaValid = true;
  }
}
