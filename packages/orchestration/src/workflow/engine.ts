import type {
  UsageTotals,
  WorkflowAgentStep,
  WorkflowRunSnapshot,
  WorkflowStepErrorCode,
  WorkflowStepSnapshot,
  WorkflowStepState
} from '@desktop-agent/contracts';
import { createLinkedAbortController } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import { assertOutputSchema, validateStructuredOutput } from '../structured-output.js';
import { accrueUsage, emptyUsage } from '../usage.js';
import { AgentExecutionScheduler } from '../subagent/scheduler.js';
import type { LeafAgentRunner, LeafAgentRunResult } from '../subagent/types.js';
import { resolveWorkflowStepInputs } from './data/references.js';
import { buildStepPrompt, truncateWorkflowOutput } from './prompt-builder.js';
import { shouldRetryWorkflowStep, waitForRetryBackoff } from './retry.js';
import type { WorkflowEngineCallbacks, WorkflowExecutionRequest } from './types.js';

const FAILURE_STATES = new Set<WorkflowStepState>(['failed', 'timed_out', 'cancelled', 'blocked', 'interrupted']);
const TERMINAL_STATES = new Set<WorkflowStepState>(['completed', ...FAILURE_STATES]);

function effectiveStepModel(step: WorkflowAgentStep, workflowModel: string): string {
  return step.model && step.model !== 'inherit' ? step.model : workflowModel;
}

function cloneSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return {
    ...snapshot,
    usage: { ...snapshot.usage },
    steps: snapshot.steps.map((step) => ({
      ...step,
      ...(step.structuredResult !== undefined ? { structuredResult: structuredClone(step.structuredResult) } : {}),
      usage: { ...step.usage }
    })),
    failedStepIds: [...snapshot.failedStepIds],
    blockedStepIds: [...snapshot.blockedStepIds]
  };
}

function sumUsage(steps: WorkflowStepSnapshot[]): UsageTotals {
  return steps.reduce((total, step) => ({
    inputTokens: total.inputTokens + step.usage.inputTokens,
    outputTokens: total.outputTokens + step.usage.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + step.usage.cacheReadInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + step.usage.cacheWriteInputTokens
  }), emptyUsage());
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens
  };
}

function stepFailureCode(error: unknown): WorkflowStepErrorCode {
  if (error instanceof OrchestrationError) {
    if (error.code === 'provider_timeout') return 'provider_timeout';
    if (error.code === 'provider_error') return 'provider_error';
    if (error.code === 'invalid_profile') return 'invalid_profile';
    if (error.code === 'output_schema_invalid') return 'output_schema_invalid';
    if (error.code === 'output_schema_validation_failed') return 'output_schema_validation_failed';
    if (error.code === 'workflow_reference_invalid') return 'workflow_reference_invalid';
    if (error.code === 'workflow_reference_not_found') return 'workflow_reference_not_found';
  }
  return 'workflow_step_failed';
}

export function createResumedWorkflowSnapshot(
  request: WorkflowExecutionRequest,
  previous: WorkflowRunSnapshot
): WorkflowRunSnapshot {
  return {
    id: previous.id,
    sessionId: previous.sessionId,
    name: previous.name,
    state: 'running',
    revision: previous.revision + 1,
    createdAt: previous.createdAt,
    startedAt: previous.startedAt ?? new Date().toISOString(),
    steps: request.definition.steps.map((definition) => {
      const prior = previous.steps.find((step) => step.id === definition.id);
      if (!prior) {
        return {
          id: definition.id,
          profile: definition.profile,
          model: effectiveStepModel(definition, request.model),
          state: 'pending',
          attempt: 1,
          createdAt: previous.createdAt,
          incomplete: false,
          usage: emptyUsage()
        };
      }
      if (prior.state === 'completed') return {
        ...prior,
        profile: prior.profile ?? definition.profile,
        model: prior.model ?? effectiveStepModel(definition, request.model),
        usage: { ...prior.usage }
      };
      return {
        id: prior.id,
        profile: definition.profile,
        model: effectiveStepModel(definition, request.model),
        state: 'pending',
        attempt: prior.state === 'pending' ? prior.attempt : prior.attempt + 1,
        createdAt: prior.createdAt,
        incomplete: false,
        usage: { ...prior.usage }
      };
    }),
    usage: { ...previous.usage },
    failedStepIds: [],
    blockedStepIds: [],
    incomplete: false
  };
}

export function createInitialWorkflowSnapshot(request: WorkflowExecutionRequest): WorkflowRunSnapshot {
  return {
    id: request.id,
    sessionId: request.sessionId,
    name: request.definition.name,
    state: 'running',
    revision: 0,
    createdAt: request.createdAt,
    startedAt: request.createdAt,
    steps: request.definition.steps.map((step) => ({
      id: step.id,
      profile: step.profile,
      model: effectiveStepModel(step, request.model),
      state: 'pending',
      attempt: 1,
      createdAt: request.createdAt,
      incomplete: false,
      usage: emptyUsage()
    })),
    usage: emptyUsage(),
    failedStepIds: [],
    blockedStepIds: [],
    incomplete: false
  };
}

export class WorkflowEngine {
  constructor(
    private readonly runner: LeafAgentRunner,
    private readonly scheduler: AgentExecutionScheduler
  ) {}

  async run(
    request: WorkflowExecutionRequest,
    signal: AbortSignal,
    callbacks: WorkflowEngineCallbacks,
    initialSnapshot?: WorkflowRunSnapshot
  ): Promise<WorkflowRunSnapshot> {
    let snapshot = initialSnapshot
      ? createResumedWorkflowSnapshot(request, initialSnapshot)
      : createInitialWorkflowSnapshot(request);
    let workflowTimedOut = false;
    let workflowDeadlocked = false;
    const workflowController = createLinkedAbortController([signal]);
    const workflowTimer = setTimeout(() => {
      workflowTimedOut = true;
      workflowController.controller.abort();
    }, request.definition.timeoutMs);
    const running = new Map<string, Promise<void>>();
    const definitions = new Map(request.definition.steps.map((step) => [step.id, step]));

    const changed = () => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, usage: sumUsage(snapshot.steps) };
      callbacks.onChanged(cloneSnapshot(snapshot));
    };
    const updateStep = (stepId: string, update: Partial<WorkflowStepSnapshot>) => {
      snapshot = {
        ...snapshot,
        steps: snapshot.steps.map((step) => step.id === stepId ? { ...step, ...update } : step)
      };
      changed();
    };
    const resetStepForRetry = (stepId: string, attempt: number) => {
      snapshot = {
        ...snapshot,
        steps: snapshot.steps.map((step) => {
          if (step.id !== stepId) return step;
          return {
            id: step.id,
            ...(step.profile ? { profile: step.profile } : {}),
            ...(step.model ? { model: step.model } : {}),
            state: 'queued' as const,
            attempt,
            createdAt: step.createdAt,
            ...(step.startedAt ? { startedAt: step.startedAt } : {}),
            incomplete: false,
            usage: { ...step.usage }
          };
        })
      };
      changed();
    };
    const log = (level: 'info' | 'warning' | 'error', message: string, stepId?: string) => callbacks.onLog({
      type: 'workflow.log', runId: request.id, ...(stepId ? { stepId } : {}), level, message, createdAt: new Date().toISOString()
    });

    const dependencySnapshots = (step: WorkflowAgentStep) => step.dependsOn.map((id) => snapshot.steps.find((item) => item.id === id)!);
    const dependencyAllowsContinuation = (dependencyId: string) => definitions.get(dependencyId)?.continueOnError === true;
    const isBlocked = (step: WorkflowAgentStep) => dependencySnapshots(step).some(
      (dependency) => FAILURE_STATES.has(dependency.state) && !dependencyAllowsContinuation(dependency.id)
    );
    const isReady = (step: WorkflowAgentStep) => dependencySnapshots(step).every(
      (dependency) => dependency.state === 'completed'
        || (TERMINAL_STATES.has(dependency.state) && dependencyAllowsContinuation(dependency.id))
    );

    const executeStep = async (step: WorkflowAgentStep): Promise<void> => {
      updateStep(step.id, { state: 'queued' });
      let attemptsThisRun = 0;
      while (!workflowController.controller.signal.aborted) {
        attemptsThisRun += 1;
        const stepController = createLinkedAbortController([workflowController.controller.signal]);
        let release: (() => void) | undefined;
        let stepTimedOut = false;
        let stepTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          release = await this.scheduler.acquire(stepController.controller.signal);
          if (workflowController.controller.signal.aborted) return;
          const current = snapshot.steps.find((item) => item.id === step.id)!;
          updateStep(step.id, {
            state: 'running',
            ...(current.startedAt ? {} : { startedAt: new Date().toISOString() })
          });
          log('info', `Started workflow agent step attempt ${current.attempt}.`, step.id);
          const baseUsage = { ...current.usage };
          stepTimer = setTimeout(() => {
            stepTimedOut = true;
            stepController.controller.abort();
          }, step.timeoutMs ?? 120_000);
          if (step.outputSchema) assertOutputSchema(step.outputSchema);
          const model = effectiveStepModel(step, request.model);
          const dependencies = dependencySnapshots(step);
          const resolvedInputs = resolveWorkflowStepInputs(step, dependencies, request.args);
          const result = await this.runner.run({
            id: `${request.id}:${step.id}`,
            sessionId: request.sessionId,
            workingDirectory: request.workingDirectory,
            task: buildStepPrompt(step, dependencies, resolvedInputs),
            profile: step.profile,
            providerId: request.providerId,
            model,
            maxIterations: step.maxIterations ?? 8,
            timeoutMs: step.timeoutMs ?? 120_000,
            ...(step.tools ? { tools: step.tools } : {}),
            ...(step.readOnly !== undefined ? { readOnly: step.readOnly } : {}),
            ...(step.outputSchema ? { outputSchema: step.outputSchema } : {})
          }, stepController.controller.signal, (event) => {
            if (event.type !== 'usage') return;
            const latest = snapshot.steps.find((item) => item.id === step.id);
            if (!latest || TERMINAL_STATES.has(latest.state)) return;
            const usage = { ...latest.usage };
            accrueUsage(usage, event);
            updateStep(step.id, { usage });
          });
          if (result.model && result.model !== model) updateStep(step.id, { model: result.model });
          this.completeStep(step, result, baseUsage, stepTimedOut, workflowController.controller.signal.aborted, workflowTimedOut, updateStep, log);
        } catch (error) {
          if (workflowTimedOut) {
            updateStep(step.id, { state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', incomplete: true, finishedAt: new Date().toISOString() });
          } else if (stepTimedOut) {
            updateStep(step.id, { state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout', error: 'Workflow step timed out.', incomplete: true, finishedAt: new Date().toISOString() });
            log('error', 'Workflow step timed out.', step.id);
          } else if (workflowController.controller.signal.aborted) {
            updateStep(step.id, { state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled', incomplete: true, finishedAt: new Date().toISOString() });
          } else {
            const errorCode = stepFailureCode(error);
            updateStep(step.id, {
              state: 'failed', stopReason: errorCode, errorCode,
              ...(errorCode === 'output_schema_invalid' || errorCode === 'output_schema_validation_failed' ? { schemaValid: false } : {}),
              error: error instanceof Error ? error.message : String(error), incomplete: true, finishedAt: new Date().toISOString()
            });
            log('error', error instanceof Error ? error.message : String(error), step.id);
          }
        } finally {
          if (stepTimer) clearTimeout(stepTimer);
          stepController.dispose();
          release?.();
        }

        const failedAttempt = snapshot.steps.find((item) => item.id === step.id)!;
        if (!shouldRetryWorkflowStep(step.retry, failedAttempt.errorCode, attemptsThisRun)) return;
        const nextAttempt = failedAttempt.attempt + 1;
        resetStepForRetry(step.id, nextAttempt);
        log('warning', `Retrying after ${failedAttempt.errorCode}; attempt ${nextAttempt} starts in ${step.retry!.backoffMs}ms.`, step.id);
        try {
          await waitForRetryBackoff(step.retry!.backoffMs, workflowController.controller.signal);
        } catch {
          updateStep(step.id, {
            state: 'cancelled',
            stopReason: workflowTimedOut ? 'workflow_timeout' : 'cancelled',
            errorCode: workflowTimedOut ? 'workflow_timeout' : 'workflow_cancelled',
            incomplete: true,
            finishedAt: new Date().toISOString()
          });
          return;
        }
      }
    };

    try {
      changed();
      while (snapshot.steps.some((step) => !TERMINAL_STATES.has(step.state))) {
        if (workflowController.controller.signal.aborted) break;

        for (const step of request.definition.steps) {
          const current = snapshot.steps.find((item) => item.id === step.id)!;
          if (current.state === 'pending' && isBlocked(step)) {
            updateStep(step.id, { state: 'blocked', error: 'Blocked by a failed dependency.', incomplete: true, finishedAt: new Date().toISOString() });
            log('warning', 'Blocked by a failed dependency.', step.id);
          }
        }

        const ready = request.definition.steps.filter((step) => {
          const current = snapshot.steps.find((item) => item.id === step.id)!;
          return current.state === 'pending' && isReady(step);
        });
        while (ready.length > 0 && running.size < request.definition.maxConcurrency) {
          const step = ready.shift()!;
          const promise = executeStep(step).finally(() => running.delete(step.id));
          running.set(step.id, promise);
        }
        if (running.size === 0) {
          const unresolved = snapshot.steps.filter((step) => !TERMINAL_STATES.has(step.state));
          if (unresolved.length > 0) {
            workflowDeadlocked = true;
            for (const step of unresolved) {
              updateStep(step.id, {
                state: 'blocked', stopReason: 'workflow_deadlock', errorCode: 'workflow_deadlock',
                error: 'No runnable steps remain while dependencies are unresolved.', incomplete: true, finishedAt: new Date().toISOString()
              });
            }
          }
          break;
        }
        await Promise.race(running.values());
      }
      if (running.size > 0) await Promise.allSettled(running.values());
    } finally {
      clearTimeout(workflowTimer);
      workflowController.dispose();
    }

    if (workflowController.controller.signal.aborted) {
      for (const step of snapshot.steps) {
        if (!TERMINAL_STATES.has(step.state)) {
          updateStep(step.id, {
            state: 'cancelled', stopReason: workflowTimedOut ? 'workflow_timeout' : 'cancelled',
            errorCode: workflowTimedOut ? 'workflow_timeout' : 'workflow_cancelled', incomplete: true, finishedAt: new Date().toISOString()
          });
        }
      }
    }
    const failedStepIds = snapshot.steps.filter((step) => ['failed', 'timed_out', 'cancelled'].includes(step.state)).map((step) => step.id);
    const blockedStepIds = snapshot.steps.filter((step) => step.state === 'blocked').map((step) => step.id);
    const fatalFailures = [...failedStepIds, ...blockedStepIds].filter((id) => !definitions.get(id)?.continueOnError);
    const state = workflowTimedOut ? 'timed_out' : signal.aborted ? 'cancelled' : workflowDeadlocked || fatalFailures.length > 0 ? 'failed' : 'completed';
    const incomplete = snapshot.steps.some((step) => step.incomplete || step.state !== 'completed');
    const output = this.workflowOutput(request, snapshot.steps);
    snapshot = {
      ...snapshot,
      state,
      revision: snapshot.revision + 1,
      finishedAt: new Date().toISOString(),
      usage: sumUsage(snapshot.steps),
      failedStepIds,
      blockedStepIds,
      ...(output ? { result: output } : {}),
      ...(workflowTimedOut ? { errorCode: 'workflow_timeout' as const, error: 'Workflow timed out.' }
        : signal.aborted ? { errorCode: 'workflow_cancelled' as const, error: 'Workflow was cancelled.' }
          : workflowDeadlocked ? { errorCode: 'workflow_deadlock' as const, error: 'Workflow stopped because no runnable steps remained.' }
            : fatalFailures.length > 0 ? { errorCode: 'workflow_step_failed' as const, error: `Workflow failed at step(s): ${fatalFailures.join(', ')}` }
              : {}),
      incomplete
    };
    callbacks.onChanged(cloneSnapshot(snapshot));
    return cloneSnapshot(snapshot);
  }

  private completeStep(
    step: WorkflowAgentStep,
    result: LeafAgentRunResult,
    baseUsage: UsageTotals,
    stepTimedOut: boolean,
    workflowAborted: boolean,
    workflowTimedOut: boolean,
    update: (stepId: string, values: Partial<WorkflowStepSnapshot>) => void,
    log: (level: 'info' | 'warning' | 'error', message: string, stepId?: string) => void
  ): void {
    const output = truncateWorkflowOutput(result.result);
    if (workflowAborted && workflowTimedOut) {
      update(step.id, {
        state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', output: output.output,
        usage: addUsage(baseUsage, result.usage), incomplete: true, finishedAt: new Date().toISOString()
      });
    } else if (stepTimedOut) {
      update(step.id, { state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout', output: output.output, usage: addUsage(baseUsage, result.usage), incomplete: true, finishedAt: new Date().toISOString() });
      log('error', 'Workflow step timed out.', step.id);
    } else if (workflowAborted || result.stopReason === 'cancelled') {
      update(step.id, {
        state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled',
        output: output.output, usage: addUsage(baseUsage, result.usage), incomplete: true, finishedAt: new Date().toISOString()
      });
    } else {
      const structured = step.outputSchema ? validateStructuredOutput(result.result, step.outputSchema) : undefined;
      if (structured && !structured.ok) {
        update(step.id, {
          state: 'failed', stopReason: structured.code, errorCode: structured.code,
          output: output.output, schemaValid: false, error: structured.message,
          usage: addUsage(baseUsage, result.usage), incomplete: true, finishedAt: new Date().toISOString()
        });
        log('error', structured.message, step.id);
        return;
      }
      update(step.id, {
        state: 'completed', stopReason: result.stopReason, output: output.output, usage: addUsage(baseUsage, result.usage),
        ...(structured?.ok ? { structuredResult: structuredClone(structured.value), schemaValid: true } : {}),
        ...(result.stopReason === 'max_iterations' ? { errorCode: 'max_iterations' as const } : {}),
        incomplete: result.incomplete || output.truncated, finishedAt: new Date().toISOString()
      });
      log(result.incomplete || output.truncated ? 'warning' : 'info', 'Completed workflow agent step.', step.id);
    }
  }

  private workflowOutput(request: WorkflowExecutionRequest, steps: WorkflowStepSnapshot[]): string {
    if (request.definition.outputStepId) {
      return steps.find((step) => step.id === request.definition.outputStepId)?.output ?? '';
    }
    return steps.filter((step) => step.output).map((step) => `[${step.id}]\n${step.output}`).join('\n\n');
  }
}
