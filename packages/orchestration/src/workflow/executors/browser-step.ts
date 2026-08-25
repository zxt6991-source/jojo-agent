import { createHash } from 'node:crypto';
import type { WorkflowStepErrorCode } from '@desktop-agent/contracts';
import { OrchestrationError } from '../../errors.js';
import { assertOutputSchema, validateStructuredOutput } from '../../structured-output.js';
import { emptyUsage } from '../../usage.js';
import type {
  WorkflowRecordingRuntime,
  WorkflowStepExecutionContext,
  WorkflowStepExecutionResult,
  WorkflowStepExecutor
} from './types.js';

function browserRunId(workflowId: string, stepId: string): string {
  return `brun_${createHash('sha256').update(`${workflowId}\0${stepId}`).digest('hex').slice(0, 32)}`;
}

function mergedParams(
  staticParams: Record<string, string | number | boolean>,
  resolvedInputs: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = { ...staticParams };
  for (const [name, value] of Object.entries(resolvedInputs ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new OrchestrationError('workflow_reference_invalid', `Browser recording param ${name} must resolve to a string, number, or boolean.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new OrchestrationError('workflow_reference_invalid', `Browser recording param ${name} must be finite.`);
    }
    params[name] = value as string | number | boolean;
  }
  if (Object.keys(params).length > 64) throw new OrchestrationError('workflow_reference_invalid', 'Browser recording steps may bind at most 64 params.');
  return params;
}

export class RecordingStepExecutor implements WorkflowStepExecutor {
  readonly type = 'recording' as const;
  readonly usesAgentScheduler = false;

  constructor(private readonly runtime?: WorkflowRecordingRuntime) {}

  async execute(context: WorkflowStepExecutionContext): Promise<WorkflowStepExecutionResult> {
    const step = context.step;
    if (step.type !== 'recording') {
      throw new OrchestrationError('workflow_step_type_unsupported', `Recording executor cannot run step type: ${step.type}`);
    }
    if (!this.runtime) throw new OrchestrationError('workflow_step_type_unsupported', 'Workflow browser runtime is not configured.');
    if (!context.request.browserApproved) {
      return failure('Browser workflow steps require approval when the workflow starts.', 'permission_denied');
    }
    const runId = browserRunId(context.request.id, step.id);
    if (step.outputSchema) assertOutputSchema(step.outputSchema);
    const resume = context.attempt > 1;
    context.log('info', `${resume ? 'Resuming' : 'Starting'} browser recording ${step.recording} as ${runId}.`);
    const result = await this.runtime.execute({
      recordingId: step.recording,
      params: mergedParams(step.params, context.resolvedInputs),
      runId,
      resume,
      maxRetries: step.maxRetries,
      retryDelayMs: step.retryDelayMs,
      sessionId: context.request.sessionId,
      workingDirectory: context.request.workingDirectory,
      signal: context.signal,
      onProgress: (text) => context.log('info', text)
    });
    if (!result.ok) return failure(result.content, browserErrorCode(result.code));
    const execution: WorkflowStepExecutionResult = {
      output: result.content,
      stopReason: 'completed',
      usage: emptyUsage(),
      incomplete: false,
      ...(result.structuredResult === undefined ? {} : { structuredResult: structuredClone(result.structuredResult), schemaValid: true })
    };
    if (step.outputSchema) {
      const structured = validateStructuredOutput(JSON.stringify(result.structuredResult) ?? '', step.outputSchema);
      if (!structured.ok) {
        return {
          ...execution,
          stopReason: structured.code,
          errorCode: structured.code,
          error: structured.message,
          schemaValid: false,
          incomplete: true
        };
      }
      execution.structuredResult = structuredClone(structured.value);
      execution.schemaValid = true;
    }
    return execution;
  }
}

function browserErrorCode(code: string | undefined): WorkflowStepErrorCode {
  if (code === 'permission_denied') return 'permission_denied';
  return code === 'browser_resume_unsafe' ? 'browser_resume_unsafe' : 'browser_replay_failed';
}

function failure(message: string, errorCode: WorkflowStepErrorCode): WorkflowStepExecutionResult {
  return {
    output: message,
    stopReason: errorCode,
    errorCode,
    error: message,
    usage: emptyUsage(),
    incomplete: true
  };
}
