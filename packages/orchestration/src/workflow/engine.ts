import type {
  UsageTotals,
  WorkflowAgentStep,
  WorkflowBudget,
  WorkflowCallStep,
  WorkflowConditionStep,
  WorkflowForeachStep,
  WorkflowRunSnapshot,
  WorkflowStep,
  WorkflowStepErrorCode,
  WorkflowStepSnapshot,
  WorkflowStepState
} from '@desktop-agent/contracts';
import { createLinkedAbortController } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import type { IsolationManager } from '../isolation/manager.js';
import { copyIsolationSnapshot } from '../isolation/types.js';
import { AgentProfileRegistry, createBuiltinAgentProfileRegistry } from '../subagent/profile-registry.js';
import { accrueUsage, emptyUsage } from '../usage.js';
import { AgentExecutionScheduler } from '../subagent/scheduler.js';
import { ProviderSemaphore } from '../subagent/provider-semaphore.js';
import {
  acquireResourceAndAgentSlots,
  ResourceGroupLimiter,
  workflowStepResources
} from '../subagent/resource-groups.js';
import type { LeafAgentRunner } from '../subagent/types.js';
import {
  agentStepBudget,
  budgetExceededMessage,
  stepConsumesBudget
} from './budget.js';
import { evaluateWorkflowCondition } from './condition.js';
import { resolveWorkflowReference, resolveWorkflowStepInputs } from './data/references.js';
import { materializeWorkflowDefinition, resolveWorkflowArgs } from './data/args.js';
import { AgentStepExecutor } from './executors/agent-step.js';
import { ToolStepExecutor } from './executors/tool-step.js';
import type { WorkflowStepExecutionResult, WorkflowStepExecutor, WorkflowToolRuntime } from './executors/types.js';
import {
  buildForeachVirtualStep,
  createForeachInstanceSnapshot,
  foreachStructuredResult,
  resolveForeachItems,
  type WorkflowInstanceSnapshot
} from './foreach.js';
import { MAX_WORKFLOW_DEPTH, asWorkflowChildSnapshot, resolveNestedWorkflowArgs } from './nested.js';
import { truncateWorkflowOutput } from './prompt-builder.js';
import { shouldRetryWorkflowStep, waitForRetryBackoff } from './retry.js';
import type { SavedWorkflowRegistry } from './saved/registry.js';
import type { WorkflowEngineCallbacks, WorkflowExecutionRequest } from './types.js';

export type WorkflowEngineOptions = {
  isolation?: IsolationManager;
  profileRegistry?: AgentProfileRegistry;
  toolRuntime?: WorkflowToolRuntime;
  savedWorkflows?: SavedWorkflowRegistry;
  maxWorkflowDepth?: number;
  resourceGroups?: ResourceGroupLimiter;
  providers?: ProviderSemaphore;
};

const FAILURE_STATES = new Set<WorkflowStepState>(['failed', 'timed_out', 'cancelled', 'blocked', 'interrupted']);
const TERMINAL_STATES = new Set<WorkflowStepState>(['completed', 'skipped', ...FAILURE_STATES]);

function effectiveStepModel(step: WorkflowAgentStep, workflowModel: string): string {
  return step.model && step.model !== 'inherit' ? step.model : workflowModel;
}

function stepSnapshotIdentity(
  step: WorkflowStep,
  workflowModel: string,
  memorySnapshotId?: string
): Pick<WorkflowStepSnapshot,
  'type' | 'profile' | 'tool' | 'model' | 'workflow' | 'resourceGroup' | 'dependsOn' | 'memorySnapshotId'
> {
  const dependsOn = { dependsOn: [...step.dependsOn] };
  const resourceGroup = workflowStepResources(step)?.group;
  const group = resourceGroup ? { resourceGroup } : {};
  const memory = memorySnapshotId ? { memorySnapshotId } : {};
  if (step.type === 'tool') return { type: 'tool', tool: step.tool, ...dependsOn };
  if (step.type === 'foreach') return {
    type: 'foreach', ...group, ...(step.template.type === 'agent' ? memory : {}), ...dependsOn
  };
  if (step.type === 'condition') return { type: 'condition', ...dependsOn };
  if (step.type === 'workflow') return { type: 'workflow', workflow: step.name, ...memory, ...dependsOn };
  return {
    type: 'agent', profile: step.profile, model: effectiveStepModel(step, workflowModel),
    ...group, ...memory, ...dependsOn
  };
}

function cloneInstanceSnapshot(instance: WorkflowInstanceSnapshot): WorkflowInstanceSnapshot {
  return {
    ...instance,
    ...(instance.structuredResult !== undefined ? { structuredResult: structuredClone(instance.structuredResult) } : {}),
    ...(instance.item !== undefined ? { item: structuredClone(instance.item) } : {}),
    ...(instance.isolation ? { isolation: copyIsolationSnapshot(instance.isolation) } : {}),
    usage: { ...instance.usage }
  };
}

function cloneStepSnapshot(step: WorkflowStepSnapshot): WorkflowStepSnapshot {
  return {
    ...step,
    ...(step.structuredResult !== undefined ? { structuredResult: structuredClone(step.structuredResult) } : {}),
    ...(step.item !== undefined ? { item: structuredClone(step.item) } : {}),
    ...(step.isolation ? { isolation: copyIsolationSnapshot(step.isolation) } : {}),
    ...(step.instances ? { instances: step.instances.map((instance) => cloneInstanceSnapshot(instance)) } : {}),
    ...(step.child ? { child: structuredClone(step.child) } : {}),
    ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
    usage: { ...step.usage }
  };
}

function copyBudget(budget?: WorkflowBudget): { budget?: WorkflowBudget } {
  return budget ? { budget: { ...budget } } : {};
}

function cloneSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return {
    ...snapshot,
    ...copyBudget(snapshot.budget),
    usage: { ...snapshot.usage },
    steps: snapshot.steps.map((step) => cloneStepSnapshot(step)),
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

function hasUsage(usage: UsageTotals): boolean {
  return usage.inputTokens !== 0
    || usage.outputTokens !== 0
    || usage.cacheReadInputTokens !== 0
    || usage.cacheWriteInputTokens !== 0;
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
    if (error.code === 'isolation_required') return 'isolation_required';
    if (error.code === 'worktree_not_a_git_repository') return 'worktree_not_a_git_repository';
    if (error.code === 'worktree_create_failed') return 'worktree_create_failed';
    if (error.code === 'worktree_cleanup_failed') return 'worktree_cleanup_failed';
    if (error.code === 'worktree_path_invalid') return 'worktree_path_invalid';
    if (error.code === 'tool_not_allowed') return 'tool_not_allowed';
    if (error.code === 'permission_denied') return 'permission_denied';
    if (error.code === 'workflow_step_type_unsupported') return 'workflow_step_type_unsupported';
    if (error.code === 'foreach_items_invalid') return 'foreach_items_invalid';
    if (error.code === 'foreach_item_limit') return 'foreach_item_limit';
    if (error.code === 'workflow_depth_exceeded') return 'workflow_depth_exceeded';
    if (error.code === 'saved_workflow_not_found') return 'saved_workflow_not_found';
    if (error.code === 'workflow_invalid_args') return 'workflow_invalid_args';
    if (error.code === 'resource_group_conflict') return 'resource_group_conflict';
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
          ...stepSnapshotIdentity(definition, request.model, request.memory?.memorySnapshotId),
          state: 'pending',
          attempt: 1,
          createdAt: previous.createdAt,
          incomplete: false,
          usage: emptyUsage()
        };
      }
      if (prior.state === 'completed' || prior.state === 'skipped') {
        return cloneStepSnapshot({
          ...prior,
          ...stepSnapshotIdentity(definition, request.model, request.memory?.memorySnapshotId)
        });
      }
      if (definition.type === 'foreach') {
        return {
          id: prior.id,
          ...stepSnapshotIdentity(definition, request.model, request.memory?.memorySnapshotId),
          state: 'pending' as const,
          attempt: prior.state === 'pending' ? prior.attempt : prior.attempt + 1,
          createdAt: prior.createdAt,
          incomplete: false,
          usage: { ...prior.usage },
          ...(prior.instances ? {
            instances: prior.instances.map((instance) => (
              instance.state === 'completed'
                ? cloneInstanceSnapshot(instance)
                : {
                    id: instance.id,
                    ...(instance.type ? { type: instance.type } : {}),
                    ...(instance.profile ? { profile: instance.profile } : {}),
                    ...(instance.tool ? { tool: instance.tool } : {}),
                    ...(instance.model ? { model: instance.model } : {}),
                    ...(instance.resourceGroup ? { resourceGroup: instance.resourceGroup } : {}),
                    parentId: instance.parentId ?? definition.id,
                    ...(instance.index !== undefined ? { index: instance.index } : {}),
                    ...(instance.item !== undefined ? { item: structuredClone(instance.item) } : {}),
                    state: 'pending' as const,
                    attempt: instance.state === 'pending' ? instance.attempt : instance.attempt + 1,
                    createdAt: instance.createdAt,
                    incomplete: false,
                    usage: { ...instance.usage }
                  }
            ))
          } : {})
        };
      }
      if (definition.type === 'workflow') {
        return {
          id: prior.id,
          ...stepSnapshotIdentity(definition, request.model, request.memory?.memorySnapshotId),
          state: 'pending' as const,
          attempt: prior.state === 'pending' ? prior.attempt : prior.attempt + 1,
          createdAt: prior.createdAt,
          incomplete: false,
          usage: { ...prior.usage },
          ...(prior.child ? { child: structuredClone(prior.child) } : {})
        };
      }
      return {
        id: prior.id,
        ...stepSnapshotIdentity(definition, request.model, request.memory?.memorySnapshotId),
        state: 'pending',
        attempt: prior.state === 'pending' ? prior.attempt : prior.attempt + 1,
        createdAt: prior.createdAt,
        incomplete: false,
        usage: { ...prior.usage }
      };
    }),
    usage: { ...previous.usage },
    ...(previous.memory ? { memory: structuredClone(previous.memory) } : {}),
    ...copyBudget(request.definition.budget),
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
      ...stepSnapshotIdentity(step, request.model, request.memory?.memorySnapshotId),
      state: 'pending' as const,
      attempt: 1,
      createdAt: request.createdAt,
      incomplete: false,
      usage: emptyUsage()
    })),
    usage: emptyUsage(),
    ...(request.memory ? { memory: structuredClone(request.memory) } : {}),
    ...copyBudget(request.definition.budget),
    failedStepIds: [],
    blockedStepIds: [],
    incomplete: false
  };
}

export class WorkflowEngine {
  private readonly agentExecutor: AgentStepExecutor;
  private readonly toolExecutor: ToolStepExecutor;
  private readonly savedWorkflows: SavedWorkflowRegistry | undefined;
  private readonly maxWorkflowDepth: number;
  private readonly resourceGroups: ResourceGroupLimiter;
  private readonly providers: ProviderSemaphore;

  constructor(
    runner: LeafAgentRunner,
    private readonly scheduler: AgentExecutionScheduler,
    options: WorkflowEngineOptions = {}
  ) {
    const profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
    this.agentExecutor = new AgentStepExecutor(runner, profileRegistry, options.isolation);
    this.toolExecutor = new ToolStepExecutor(options.toolRuntime);
    this.savedWorkflows = options.savedWorkflows;
    this.maxWorkflowDepth = options.maxWorkflowDepth ?? MAX_WORKFLOW_DEPTH;
    this.resourceGroups = options.resourceGroups ?? new ResourceGroupLimiter();
    this.providers = options.providers ?? new ProviderSemaphore();
  }

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
            ...(step.type ? { type: step.type } : {}),
            ...(step.profile ? { profile: step.profile } : {}),
            ...(step.tool ? { tool: step.tool } : {}),
            ...(step.model ? { model: step.model } : {}),
            ...(step.resourceGroup ? { resourceGroup: step.resourceGroup } : {}),
            ...(step.memorySnapshotId ? { memorySnapshotId: step.memorySnapshotId } : {}),
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
    const updateInstance = (parentId: string, index: number, update: Partial<WorkflowInstanceSnapshot>) => {
      snapshot = {
        ...snapshot,
        steps: snapshot.steps.map((step) => {
          if (step.id !== parentId) return step;
          const instances = (step.instances ?? []).map((instance, instanceIndex) => (
            instanceIndex === index ? { ...instance, ...update } : instance
          ));
          return { ...step, instances, usage: sumUsage(instances) };
        })
      };
      changed();
    };
    const resetInstanceForRetry = (parentId: string, index: number, attempt: number) => {
      snapshot = {
        ...snapshot,
        steps: snapshot.steps.map((step) => {
          if (step.id !== parentId) return step;
          const instances = (step.instances ?? []).map((instance, instanceIndex) => {
            if (instanceIndex !== index) return instance;
            return {
              id: instance.id,
              ...(instance.type ? { type: instance.type } : {}),
              ...(instance.profile ? { profile: instance.profile } : {}),
              ...(instance.tool ? { tool: instance.tool } : {}),
              ...(instance.model ? { model: instance.model } : {}),
              ...(instance.resourceGroup ? { resourceGroup: instance.resourceGroup } : {}),
              parentId: instance.parentId,
              ...(instance.index !== undefined ? { index: instance.index } : {}),
              ...(instance.item !== undefined ? { item: instance.item } : {}),
              state: 'queued' as const,
              attempt,
              createdAt: instance.createdAt,
              ...(instance.startedAt ? { startedAt: instance.startedAt } : {}),
              incomplete: false,
              usage: { ...instance.usage }
            };
          });
          return { ...step, instances, usage: sumUsage(instances) };
        })
      };
      changed();
    };
    const cancelOpenInstances = (parentId: string, update: Partial<WorkflowInstanceSnapshot>) => {
      const instances = snapshot.steps.find((step) => step.id === parentId)?.instances ?? [];
      instances.forEach((instance, index) => {
        if (!TERMINAL_STATES.has(instance.state)) updateInstance(parentId, index, update);
      });
    };
    const log = (level: 'info' | 'warning' | 'error', message: string, stepId?: string) => callbacks.onLog({
      type: 'workflow.log', runId: request.id, ...(stepId ? { stepId } : {}), level, message, createdAt: new Date().toISOString()
    });
    const currentBudgetFailure = (step: WorkflowStep, stepUsage: UsageTotals) => budgetExceededMessage({
      ...(request.definition.budget ? { workflowBudget: request.definition.budget } : {}),
      ...(agentStepBudget(step) ? { stepBudget: agentStepBudget(step) } : {}),
      workflowUsage: snapshot.usage,
      stepUsage
    });
    const blockForBudget = (stepId: string, message: string, instanceIndex?: number) => {
      const patch = {
        state: 'blocked' as const,
        stopReason: 'workflow_budget_exceeded',
        errorCode: 'workflow_budget_exceeded' as const,
        error: message,
        incomplete: true,
        finishedAt: new Date().toISOString()
      };
      if (instanceIndex === undefined) updateStep(stepId, patch);
      else updateInstance(stepId, instanceIndex, patch);
      log('warning', message, instanceIndex === undefined ? stepId : `${stepId}__${instanceIndex}`);
    };

    const dependencySnapshots = (step: WorkflowStep) => step.dependsOn.map((id) => snapshot.steps.find((item) => item.id === id)!);
    const dependencyAllowsContinuation = (dependencyId: string) => definitions.get(dependencyId)?.continueOnError === true;
    const isBlocked = (step: WorkflowStep) => dependencySnapshots(step).some(
      (dependency) => FAILURE_STATES.has(dependency.state) && !dependencyAllowsContinuation(dependency.id)
    );
    const shouldSkip = (step: WorkflowStep) => {
      const dependencies = dependencySnapshots(step);
      if (dependencies.length === 0 || isBlocked(step)) return false;
      const allTerminal = dependencies.every((dependency) => TERMINAL_STATES.has(dependency.state));
      const anySkipped = dependencies.some((dependency) => dependency.state === 'skipped');
      const anyCompleted = dependencies.some((dependency) => dependency.state === 'completed');
      return allTerminal && anySkipped && !anyCompleted;
    };
    const isReady = (step: WorkflowStep) => !shouldSkip(step) && dependencySnapshots(step).every(
      (dependency) => dependency.state === 'completed'
        || dependency.state === 'skipped'
        || (TERMINAL_STATES.has(dependency.state) && dependencyAllowsContinuation(dependency.id))
    );
    const markSkipped = (stepId: string, message = 'Skipped because a condition branch was not taken.') => {
      const current = snapshot.steps.find((item) => item.id === stepId);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      updateStep(stepId, {
        state: 'skipped',
        stopReason: 'skipped',
        incomplete: false,
        finishedAt: new Date().toISOString()
      });
      log('info', message, stepId);
    };

    const executeInstance = async (
      parent: WorkflowForeachStep,
      index: number,
      item: unknown,
      parentSignal: AbortSignal,
      parentTimedOut: () => boolean
    ): Promise<void> => {
      const virtual = buildForeachVirtualStep(parent, index, item);
      const executor = this.executorFor(virtual);
      let attemptsThisRun = 0;
      while (!parentSignal.aborted) {
        attemptsThisRun += 1;
        const instanceController = createLinkedAbortController([parentSignal]);
        let release: (() => void) | undefined;
        let instanceTimedOut = false;
        let instanceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          release = await acquireResourceAndAgentSlots({
            resourceGroups: this.resourceGroups,
            signal: instanceController.controller.signal,
            providers: this.providers,
            providerId: request.providerId,
            ...(virtual.type === 'agent' && virtual.resources ? { resources: virtual.resources } : {}),
            ...(executor.usesAgentScheduler ? { scheduler: this.scheduler } : {})
          });
          if (parentSignal.aborted) return;
          const currentInstance = snapshot.steps.find((entry) => entry.id === parent.id)?.instances?.[index];
          if (!currentInstance || currentInstance.state === 'completed') return;
          if (stepConsumesBudget(virtual)) {
            const message = currentBudgetFailure(virtual, currentInstance.usage);
            if (message) {
              release();
              release = undefined;
              blockForBudget(parent.id, message, index);
              return;
            }
          }
          updateInstance(parent.id, index, {
            state: 'running',
            ...(currentInstance.startedAt ? {} : { startedAt: new Date().toISOString() })
          });
          const kind = virtual.type === 'tool' ? `tool ${virtual.tool}` : 'agent';
          log('info', `Started foreach ${kind} instance ${index} attempt ${currentInstance.attempt}.`, virtual.id);
          const baseUsage = { ...currentInstance.usage };
          instanceTimer = setTimeout(() => {
            instanceTimedOut = true;
            instanceController.controller.abort();
          }, virtual.timeoutMs ?? 120_000);
          const dependencies = dependencySnapshots(parent);
          const resolved = resolveWorkflowStepInputs(virtual, dependencies, request.args);
          const resolvedInputs = virtual.type === 'agent' ? { ...(resolved ?? {}), item, index } : resolved;
          const result = await executor.execute({
            request,
            step: virtual,
            attempt: currentInstance.attempt,
            signal: instanceController.controller.signal,
            dependencies,
            ...(resolvedInputs ? { resolvedInputs } : {}),
            onUsage: (event) => {
              if (event.type !== 'usage') return;
              const latest = snapshot.steps.find((entry) => entry.id === parent.id)?.instances?.[index];
              if (!latest || TERMINAL_STATES.has(latest.state)) return;
              const usage = { ...latest.usage };
              accrueUsage(usage, event);
              updateInstance(parent.id, index, { usage });
            },
            log: (level, message) => log(level, message, virtual.id)
          });
          if (result.model) updateInstance(parent.id, index, { model: result.model });
          this.completeStep(
            virtual,
            result,
            baseUsage,
            instanceTimedOut,
            parentSignal.aborted || workflowController.controller.signal.aborted,
            parentTimedOut() || workflowTimedOut,
            (_id, values) => updateInstance(parent.id, index, values as Partial<WorkflowInstanceSnapshot>),
            log
          );
        } catch (error) {
          if (parentTimedOut() || workflowTimedOut) {
            updateInstance(parent.id, index, {
              state: 'cancelled',
              stopReason: workflowTimedOut ? 'workflow_timeout' : 'step_timeout',
              errorCode: workflowTimedOut ? 'workflow_timeout' : 'step_timeout',
              incomplete: true,
              finishedAt: new Date().toISOString()
            });
          } else if (instanceTimedOut) {
            updateInstance(parent.id, index, {
              state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout',
              error: 'Workflow step timed out.', incomplete: true, finishedAt: new Date().toISOString()
            });
            log('error', 'Foreach instance timed out.', virtual.id);
          } else if (parentSignal.aborted || workflowController.controller.signal.aborted) {
            updateInstance(parent.id, index, {
              state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled',
              incomplete: true, finishedAt: new Date().toISOString()
            });
          } else {
            const errorCode = stepFailureCode(error);
            updateInstance(parent.id, index, {
              state: 'failed', stopReason: errorCode, errorCode,
              ...(errorCode === 'output_schema_invalid' || errorCode === 'output_schema_validation_failed' ? { schemaValid: false } : {}),
              error: error instanceof Error ? error.message : String(error), incomplete: true, finishedAt: new Date().toISOString()
            });
            log('error', error instanceof Error ? error.message : String(error), virtual.id);
          }
        } finally {
          if (instanceTimer) clearTimeout(instanceTimer);
          instanceController.dispose();
          release?.();
        }

        const failedAttempt = snapshot.steps.find((entry) => entry.id === parent.id)?.instances?.[index];
        if (!failedAttempt || !shouldRetryWorkflowStep(virtual.retry, failedAttempt.errorCode, attemptsThisRun)) return;
        if (stepConsumesBudget(virtual)) {
          const message = currentBudgetFailure(virtual, failedAttempt.usage);
          if (message) {
            log('warning', `Skipping retry because ${message}`, virtual.id);
            return;
          }
        }
        const nextAttempt = failedAttempt.attempt + 1;
        resetInstanceForRetry(parent.id, index, nextAttempt);
        log('warning', `Retrying foreach instance after ${failedAttempt.errorCode}; attempt ${nextAttempt} starts in ${virtual.retry!.backoffMs}ms.`, virtual.id);
        try {
          await waitForRetryBackoff(virtual.retry!.backoffMs, parentSignal);
        } catch {
          updateInstance(parent.id, index, {
            state: 'cancelled',
            stopReason: workflowTimedOut ? 'workflow_timeout' : parentTimedOut() ? 'step_timeout' : 'cancelled',
            errorCode: workflowTimedOut ? 'workflow_timeout' : parentTimedOut() ? 'step_timeout' : 'workflow_cancelled',
            incomplete: true,
            finishedAt: new Date().toISOString()
          });
          return;
        }
      }
    };

    const executeForeach = async (step: WorkflowForeachStep): Promise<void> => {
      updateStep(step.id, { state: 'queued' });
      const stepController = createLinkedAbortController([workflowController.controller.signal]);
      let stepTimedOut = false;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (workflowController.controller.signal.aborted) return;
        const current = snapshot.steps.find((item) => item.id === step.id)!;
        updateStep(step.id, {
          state: 'running',
          ...(current.startedAt ? {} : { startedAt: new Date().toISOString() })
        });
        log('info', `Started workflow foreach step attempt ${current.attempt}.`, step.id);
        stepTimer = setTimeout(() => {
          stepTimedOut = true;
          stepController.controller.abort();
        }, step.timeoutMs ?? 120_000);

        let items: unknown[];
        if (current.instances && current.instances.length > 0) {
          items = current.instances.map((instance) => instance.item);
        } else {
          const source = resolveWorkflowReference(step.items.valueFrom, dependencySnapshots(step), request.args);
          items = resolveForeachItems(source, step.itemLimit);
        }
        const instances = items.map((item, index) => (
          createForeachInstanceSnapshot(step, index, item, current.createdAt, current.instances?.[index])
        ));
        updateStep(step.id, { instances, usage: sumUsage(instances) });
        log('info', `Expanded foreach into ${instances.length} instance(s).`, step.id);

        if (items.length === 0) {
          updateStep(step.id, {
            state: 'completed',
            stopReason: 'completed',
            output: '[]',
            structuredResult: [],
            schemaValid: true,
            incomplete: false,
            finishedAt: new Date().toISOString(),
            instances: [],
            usage: emptyUsage()
          });
          return;
        }

        const concurrency = Math.max(1, Math.min(step.concurrency, request.definition.maxConcurrency, items.length));
        let nextIndex = 0;
        let stopNew = false;
        const workers = Array.from({ length: concurrency }, async () => {
          while (!stepController.controller.signal.aborted) {
            if (stopNew) return;
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;
            const latest = snapshot.steps.find((item) => item.id === step.id)?.instances?.[index];
            if (latest?.state === 'completed') continue;
            await executeInstance(step, index, items[index], stepController.controller.signal, () => stepTimedOut);
            const finished = snapshot.steps.find((item) => item.id === step.id)?.instances?.[index];
            if (finished && FAILURE_STATES.has(finished.state) && !step.continueOnError) stopNew = true;
          }
        });
        await Promise.all(workers);

        const parent = snapshot.steps.find((item) => item.id === step.id)!;
        const childInstances = parent.instances ?? [];
        const childFailures = childInstances.filter((instance) => FAILURE_STATES.has(instance.state));
        const finishedAt = new Date().toISOString();
        const abortPatch = {
          incomplete: true as const,
          finishedAt
        };
        if (workflowTimedOut) {
          cancelOpenInstances(step.id, { state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', ...abortPatch });
          updateStep(step.id, {
            state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout',
            structuredResult: foreachStructuredResult(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            usage: sumUsage(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            ...abortPatch
          });
        } else if (stepTimedOut) {
          cancelOpenInstances(step.id, { state: 'cancelled', stopReason: 'step_timeout', errorCode: 'step_timeout', ...abortPatch });
          updateStep(step.id, {
            state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout',
            error: 'Workflow step timed out.',
            structuredResult: foreachStructuredResult(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            usage: sumUsage(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            ...abortPatch
          });
          log('error', 'Workflow step timed out.', step.id);
        } else if (workflowController.controller.signal.aborted) {
          cancelOpenInstances(step.id, { state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled', ...abortPatch });
          updateStep(step.id, {
            state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled',
            structuredResult: foreachStructuredResult(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            usage: sumUsage(snapshot.steps.find((item) => item.id === step.id)?.instances ?? []),
            ...abortPatch
          });
        } else if (childFailures.length > 0 && !step.continueOnError) {
          cancelOpenInstances(step.id, {
            state: 'cancelled',
            stopReason: 'cancelled',
            errorCode: 'workflow_cancelled',
            error: 'Not started because a foreach instance failed.',
            incomplete: true,
            finishedAt
          });
          const latestInstances = snapshot.steps.find((item) => item.id === step.id)?.instances ?? [];
          const failure = childFailures[0]!;
          const structured = foreachStructuredResult(latestInstances);
          const output = truncateWorkflowOutput(JSON.stringify(structured));
          updateStep(step.id, {
            state: 'failed',
            stopReason: failure.errorCode ?? 'workflow_step_failed',
            errorCode: failure.errorCode ?? 'workflow_step_failed',
            error: failure.error ?? `Foreach instance failed: ${failure.id}`,
            structuredResult: structured,
            output: output.output,
            incomplete: true,
            finishedAt,
            usage: sumUsage(latestInstances)
          });
        } else {
          const structured = foreachStructuredResult(childInstances);
          const output = truncateWorkflowOutput(JSON.stringify(structured));
          updateStep(step.id, {
            state: 'completed',
            stopReason: 'completed',
            structuredResult: structured,
            output: output.output,
            schemaValid: true,
            incomplete: output.truncated || childFailures.length > 0 || childInstances.some((instance) => instance.incomplete),
            finishedAt,
            usage: sumUsage(childInstances)
          });
          log(childFailures.length > 0 ? 'warning' : 'info', `Completed workflow foreach step.`, step.id);
        }
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
            error: error instanceof Error ? error.message : String(error), incomplete: true, finishedAt: new Date().toISOString()
          });
          log('error', error instanceof Error ? error.message : String(error), step.id);
        }
      } finally {
        if (stepTimer) clearTimeout(stepTimer);
        stepController.dispose();
      }
    };

    const executeCondition = async (step: WorkflowConditionStep): Promise<void> => {
      updateStep(step.id, { state: 'queued' });
      try {
        if (workflowController.controller.signal.aborted) return;
        const current = snapshot.steps.find((item) => item.id === step.id)!;
        updateStep(step.id, {
          state: 'running',
          ...(current.startedAt ? {} : { startedAt: new Date().toISOString() })
        });
        log('info', 'Started workflow condition step.', step.id);
        const matched = evaluateWorkflowCondition(step.when, dependencySnapshots(step), request.args);
        for (const id of matched ? step.else : step.then) {
          markSkipped(id);
        }
        const structured = { matched };
        updateStep(step.id, {
          state: 'completed',
          stopReason: 'completed',
          structuredResult: structured,
          output: JSON.stringify(structured),
          schemaValid: true,
          incomplete: false,
          finishedAt: new Date().toISOString()
        });
        log('info', `Condition matched=${String(matched)}.`, step.id);
      } catch (error) {
        if (workflowTimedOut) {
          updateStep(step.id, { state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', incomplete: true, finishedAt: new Date().toISOString() });
        } else if (workflowController.controller.signal.aborted) {
          updateStep(step.id, { state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled', incomplete: true, finishedAt: new Date().toISOString() });
        } else {
          const errorCode = stepFailureCode(error);
          updateStep(step.id, {
            state: 'failed', stopReason: errorCode, errorCode,
            error: error instanceof Error ? error.message : String(error), incomplete: true, finishedAt: new Date().toISOString()
          });
          log('error', error instanceof Error ? error.message : String(error), step.id);
        }
      }
    };

    const executeWorkflowCall = async (step: WorkflowCallStep): Promise<void> => {
      updateStep(step.id, { state: 'queued' });
      const stepController = createLinkedAbortController([workflowController.controller.signal]);
      let stepTimedOut = false;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (workflowController.controller.signal.aborted) return;
        const current = snapshot.steps.find((item) => item.id === step.id)!;
        updateStep(step.id, {
          state: 'running',
          workflow: step.name,
          ...(current.startedAt ? {} : { startedAt: new Date().toISOString() })
        });
        log('info', `Started nested workflow ${step.name}.`, step.id);
        const depth = (request.depth ?? 1) + 1;
        if (depth > this.maxWorkflowDepth) {
          throw new OrchestrationError(
            'workflow_depth_exceeded',
            `Workflow nesting cannot exceed ${this.maxWorkflowDepth}.`
          );
        }
        if (!this.savedWorkflows) {
          throw new OrchestrationError('saved_workflow_not_found', `Unknown saved workflow: ${step.name}`);
        }
        const saved = this.savedWorkflows.get(step.name, request.workingDirectory);
        const nestedArgs = resolveWorkflowArgs(
          saved.definition.inputs,
          resolveNestedWorkflowArgs(step, dependencySnapshots(step), request.args)
        );
        const previousChild = asWorkflowChildSnapshot(current.child);
        const childRequest: WorkflowExecutionRequest = {
          id: `${request.id}:${step.id}`,
          sessionId: request.sessionId,
          workingDirectory: request.workingDirectory,
          providerId: request.providerId,
          model: request.model,
          args: nestedArgs,
          definition: materializeWorkflowDefinition(saved.definition, nestedArgs),
          createdAt: previousChild?.createdAt ?? new Date().toISOString(),
          ...(request.memory ? { memory: request.memory } : {}),
          depth
        };
        stepTimer = setTimeout(() => {
          stepTimedOut = true;
          stepController.controller.abort();
        }, step.timeoutMs ?? 120_000);
        const child = await this.run(childRequest, stepController.controller.signal, {
          onChanged: (childSnapshot) => {
            const latest = snapshot.steps.find((item) => item.id === step.id);
            if (!latest || TERMINAL_STATES.has(latest.state)) return;
            updateStep(step.id, { child: childSnapshot, usage: childSnapshot.usage });
          },
          onLog: (event) => log(event.level, event.message, event.stepId ? `${step.id}/${event.stepId}` : step.id)
        }, previousChild);
        const finishedAt = new Date().toISOString();
        if (workflowTimedOut) {
          updateStep(step.id, {
            state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout',
            child, usage: child.usage, incomplete: true, finishedAt
          });
        } else if (stepTimedOut) {
          updateStep(step.id, {
            state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout',
            error: 'Workflow step timed out.', child, usage: child.usage, incomplete: true, finishedAt
          });
          log('error', 'Workflow step timed out.', step.id);
        } else if (workflowController.controller.signal.aborted || child.state === 'cancelled') {
          updateStep(step.id, {
            state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled',
            child, usage: child.usage, incomplete: true, finishedAt
          });
        } else if (child.state === 'timed_out') {
          updateStep(step.id, {
            state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout',
            ...(child.error ? { error: child.error } : {}),
            child, usage: child.usage, incomplete: true, finishedAt
          });
        } else if (child.state !== 'completed') {
          updateStep(step.id, {
            state: 'failed',
            stopReason: 'workflow_step_failed',
            errorCode: 'workflow_step_failed',
            error: child.error ?? `Nested workflow ${step.name} failed.`,
            ...(child.result ? { output: child.result } : {}),
            child, usage: child.usage, incomplete: true, finishedAt
          });
          log('error', child.error ?? `Nested workflow ${step.name} failed.`, step.id);
        } else {
          const output = truncateWorkflowOutput(child.result ?? '');
          updateStep(step.id, {
            state: 'completed',
            stopReason: 'completed',
            output: output.output,
            structuredResult: child.result,
            child,
            usage: child.usage,
            incomplete: child.incomplete || output.truncated,
            finishedAt
          });
          log(child.incomplete || output.truncated ? 'warning' : 'info', `Completed nested workflow ${step.name}.`, step.id);
        }
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
            error: error instanceof Error ? error.message : String(error), incomplete: true, finishedAt: new Date().toISOString()
          });
          log('error', error instanceof Error ? error.message : String(error), step.id);
        }
      } finally {
        if (stepTimer) clearTimeout(stepTimer);
        stepController.dispose();
      }
    };

    const executeStep = async (step: WorkflowStep): Promise<void> => {
      if (step.type === 'foreach') {
        await executeForeach(step);
        return;
      }
      if (step.type === 'condition') {
        await executeCondition(step);
        return;
      }
      if (step.type === 'workflow') {
        await executeWorkflowCall(step);
        return;
      }
      const executor = this.executorFor(step);
      if (stepConsumesBudget(step)) {
        const current = snapshot.steps.find((item) => item.id === step.id)!;
        const message = currentBudgetFailure(step, current.usage);
        if (message) {
          blockForBudget(step.id, message);
          return;
        }
      }
      updateStep(step.id, { state: 'queued' });
      let attemptsThisRun = 0;
      while (!workflowController.controller.signal.aborted) {
        attemptsThisRun += 1;
        const stepController = createLinkedAbortController([workflowController.controller.signal]);
        let release: (() => void) | undefined;
        let stepTimedOut = false;
        let stepTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          release = await acquireResourceAndAgentSlots({
            resourceGroups: this.resourceGroups,
            signal: stepController.controller.signal,
            providers: this.providers,
            providerId: request.providerId,
            ...(step.type === 'agent' && step.resources ? { resources: step.resources } : {}),
            ...(executor.usesAgentScheduler ? { scheduler: this.scheduler } : {})
          });
          if (workflowController.controller.signal.aborted) return;
          const current = snapshot.steps.find((item) => item.id === step.id)!;
          if (stepConsumesBudget(step)) {
            const message = currentBudgetFailure(step, current.usage);
            if (message) {
              release();
              release = undefined;
              blockForBudget(step.id, message);
              return;
            }
          }
          updateStep(step.id, {
            state: 'running',
            ...(current.startedAt ? {} : { startedAt: new Date().toISOString() })
          });
          const kind = step.type === 'tool' ? `tool ${step.tool}` : 'agent';
          log('info', `Started workflow ${kind} step attempt ${current.attempt}.`, step.id);
          const baseUsage = { ...current.usage };
          stepTimer = setTimeout(() => {
            stepTimedOut = true;
            stepController.controller.abort();
          }, step.timeoutMs ?? 120_000);
          const dependencies = dependencySnapshots(step);
          const resolvedInputs = resolveWorkflowStepInputs(step, dependencies, request.args);
          const result = await executor.execute({
            request,
            step,
            attempt: current.attempt,
            signal: stepController.controller.signal,
            dependencies,
            ...(resolvedInputs ? { resolvedInputs } : {}),
            onUsage: (event) => {
              if (event.type !== 'usage') return;
              const latest = snapshot.steps.find((item) => item.id === step.id);
              if (!latest || TERMINAL_STATES.has(latest.state)) return;
              const usage = { ...latest.usage };
              accrueUsage(usage, event);
              updateStep(step.id, { usage });
            },
            log: (level, message) => log(level, message, step.id)
          });
          if (result.model) updateStep(step.id, { model: result.model });
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
        if (stepConsumesBudget(step)) {
          const message = currentBudgetFailure(step, failedAttempt.usage);
          if (message) {
            log('warning', `Skipping retry because ${message}`, step.id);
            return;
          }
        }
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
          } else if (current.state === 'pending' && shouldSkip(step)) {
            markSkipped(step.id);
          }
        }

        const ready = request.definition.steps.filter((step) => {
          const current = snapshot.steps.find((item) => item.id === step.id)!;
          return current.state === 'pending' && isReady(step);
        });
        while (ready.length > 0 && running.size < request.definition.maxConcurrency) {
          const step = ready.shift()!;
          if (stepConsumesBudget(step)) {
            const current = snapshot.steps.find((item) => item.id === step.id)!;
            const message = currentBudgetFailure(step, current.usage);
            if (message) {
              blockForBudget(step.id, message);
              continue;
            }
          }
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
      const finishedAt = new Date().toISOString();
      const patch = {
        state: 'cancelled' as const,
        stopReason: workflowTimedOut ? 'workflow_timeout' : 'cancelled',
        errorCode: workflowTimedOut ? 'workflow_timeout' as const : 'workflow_cancelled' as const,
        incomplete: true,
        finishedAt
      };
      for (const step of snapshot.steps) {
        if (step.instances) {
          step.instances.forEach((instance, index) => {
            if (!TERMINAL_STATES.has(instance.state)) updateInstance(step.id, index, patch);
          });
        }
        if (!TERMINAL_STATES.has(step.state)) updateStep(step.id, patch);
      }
    }
    const failedStepIds = snapshot.steps.filter((step) => ['failed', 'timed_out', 'cancelled'].includes(step.state)).map((step) => step.id);
    const blockedStepIds = snapshot.steps.filter((step) => step.state === 'blocked').map((step) => step.id);
    const fatalFailures = [...failedStepIds, ...blockedStepIds].filter((id) => !definitions.get(id)?.continueOnError);
    const state = workflowTimedOut ? 'timed_out' : signal.aborted ? 'cancelled' : workflowDeadlocked || fatalFailures.length > 0 ? 'failed' : 'completed';
    const incomplete = snapshot.steps.some((step) => step.incomplete || (step.state !== 'completed' && step.state !== 'skipped'));
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

  private executorFor(step: WorkflowStep): WorkflowStepExecutor {
    if (step.type === 'agent') return this.agentExecutor;
    if (step.type === 'tool') return this.toolExecutor;
    throw new OrchestrationError('workflow_step_type_unsupported', `Unsupported workflow step type: ${(step as WorkflowStep).type}`);
  }

  private completeStep(
    step: WorkflowStep,
    result: WorkflowStepExecutionResult,
    baseUsage: UsageTotals,
    stepTimedOut: boolean,
    workflowAborted: boolean,
    workflowTimedOut: boolean,
    update: (stepId: string, values: Partial<WorkflowStepSnapshot>) => void,
    log: (level: 'info' | 'warning' | 'error', message: string, stepId?: string) => void
  ): void {
    const output = truncateWorkflowOutput(result.output);
    const usage = addUsage(baseUsage, result.usage);
    const usagePatch = hasUsage(result.usage) ? { usage } : {};
    const isolation = result.isolation ? { isolation: result.isolation } : {};
    const finishedAt = new Date().toISOString();
    if (workflowAborted && workflowTimedOut) {
      update(step.id, {
        state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', output: output.output,
        incomplete: true, finishedAt, ...usagePatch, ...isolation
      });
    } else if (stepTimedOut) {
      update(step.id, {
        state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout', output: output.output,
        incomplete: true, finishedAt, ...usagePatch, ...isolation
      });
      log('error', 'Workflow step timed out.', step.id);
    } else if (workflowAborted || result.stopReason === 'cancelled') {
      update(step.id, {
        state: 'cancelled', stopReason: 'cancelled', errorCode: 'workflow_cancelled',
        output: output.output, incomplete: true, finishedAt, ...usagePatch, ...isolation
      });
    } else if (result.errorCode && result.errorCode !== 'max_iterations') {
      update(step.id, {
        state: 'failed', stopReason: result.stopReason, errorCode: result.errorCode,
        output: output.output,
        ...(result.schemaValid === false ? { schemaValid: false } : {}),
        ...(result.error ? { error: result.error } : {}),
        incomplete: true, finishedAt, ...usagePatch, ...isolation
      });
      log('error', result.error ?? result.errorCode, step.id);
    } else {
      update(step.id, {
        state: 'completed', stopReason: result.stopReason, output: output.output, usage,
        ...(result.structuredResult !== undefined ? { structuredResult: structuredClone(result.structuredResult), schemaValid: true } : {}),
        ...(result.stopReason === 'max_iterations' ? { errorCode: 'max_iterations' as const } : {}),
        incomplete: result.incomplete || output.truncated, finishedAt, ...isolation
      });
      const kind = step.type === 'tool' ? 'tool' : 'agent';
      log(result.incomplete || output.truncated ? 'warning' : 'info', `Completed workflow ${kind} step.`, step.id);
    }
  }

  private workflowOutput(request: WorkflowExecutionRequest, steps: WorkflowStepSnapshot[]): string {
    if (request.definition.outputStepId) {
      return steps.find((step) => step.id === request.definition.outputStepId)?.output ?? '';
    }
    return steps.filter((step) => step.output).map((step) => `[${step.id}]\n${step.output}`).join('\n\n');
  }
}
