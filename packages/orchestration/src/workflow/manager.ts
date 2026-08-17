import {
  WorkflowDefinitionSchema,
  type OrchestrationEvent,
  type WorkflowRunSnapshot,
  type WorkflowRunState
} from '@desktop-agent/contracts';
import { parse as parseYaml } from 'yaml';
import { abortError } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import { materializeWorkflowDefinition, resolveWorkflowArgs } from './data/args.js';
import { WorkflowEngine, createInitialWorkflowSnapshot, createResumedWorkflowSnapshot } from './engine.js';
import type { WorkflowPersistence } from './persistence.js';
import type { SavedWorkflowRegistry } from './saved/registry.js';
import type { SavedWorkflowSummary } from './saved/types.js';
import type { WorkflowExecutionRequest, WorkflowStartRequest } from './types.js';

const TERMINAL_STATES = new Set<WorkflowRunState>(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const MAX_SERIALIZED_DEFINITION_CHARACTERS = 120_000;

type LiveWorkflow = {
  request: WorkflowExecutionRequest;
  snapshot: WorkflowRunSnapshot;
  controller: AbortController | undefined;
  done: Promise<void>;
  resolveDone: () => void;
  settled: boolean;
  cancelRequested: boolean;
  persistenceWrites: Promise<void>;
  persistenceError: Error | undefined;
  definitionHashMatches: boolean;
  persistedDefinitionHash?: string;
};

export type WorkflowManagerOptions = {
  maxPerSession?: number;
  retention?: number;
  persistence?: WorkflowPersistence;
  savedWorkflows?: SavedWorkflowRegistry;
};

function cloneSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return {
    ...snapshot,
    ...(snapshot.budget ? { budget: { ...snapshot.budget } } : {}),
    usage: { ...snapshot.usage },
    steps: snapshot.steps.map((step) => ({
      ...step,
      ...(step.structuredResult !== undefined ? { structuredResult: structuredClone(step.structuredResult) } : {}),
      ...(step.item !== undefined ? { item: structuredClone(step.item) } : {}),
      ...(step.isolation ? { isolation: { ...step.isolation, changedFiles: [...step.isolation.changedFiles] } } : {}),
      ...(step.instances ? {
        instances: step.instances.map((instance) => ({
          ...instance,
          ...(instance.structuredResult !== undefined ? { structuredResult: structuredClone(instance.structuredResult) } : {}),
          ...(instance.item !== undefined ? { item: structuredClone(instance.item) } : {}),
          ...(instance.isolation ? { isolation: { ...instance.isolation, changedFiles: [...instance.isolation.changedFiles] } } : {}),
          usage: { ...instance.usage }
        }))
      } : {}),
      ...(step.child ? { child: structuredClone(step.child) } : {}),
      ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
      usage: { ...step.usage }
    })),
    failedStepIds: [...snapshot.failedStepIds],
    blockedStepIds: [...snapshot.blockedStepIds]
  };
}

function parseDefinition(input: unknown) {
  let candidate = input;
  if (typeof input === 'string') {
    if (input.length > MAX_SERIALIZED_DEFINITION_CHARACTERS) {
      throw new OrchestrationError('workflow_invalid_definition', `Serialized workflow definitions may not exceed ${MAX_SERIALIZED_DEFINITION_CHARACTERS} characters.`);
    }
    try { candidate = parseYaml(input, { maxAliasCount: 0 }); }
    catch (error) {
      throw new OrchestrationError('workflow_invalid_definition', error instanceof Error ? error.message : String(error));
    }
  }
  return WorkflowDefinitionSchema.safeParse(candidate);
}

export class WorkflowManager {
  private readonly workflows = new Map<string, LiveWorkflow>();
  private readonly maxPerSession: number;
  private readonly retention: number;
  private readonly persistence: WorkflowPersistence | undefined;
  private readonly savedWorkflows: SavedWorkflowRegistry | undefined;

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly emit: (event: OrchestrationEvent) => void,
    options: WorkflowManagerOptions = {}
  ) {
    this.maxPerSession = options.maxPerSession ?? 4;
    this.retention = options.retention ?? 32;
    this.persistence = options.persistence;
    this.savedWorkflows = options.savedWorkflows;
  }

  start(input: WorkflowStartRequest): WorkflowRunSnapshot {
    const definition = this.resolveDefinition(input);
    const args = resolveWorkflowArgs(definition.inputs, input.args);
    const materialized = materializeWorkflowDefinition(definition, args);
    const active = this.list(input.sessionId).filter((workflow) => !TERMINAL_STATES.has(workflow.state));
    if (active.length >= this.maxPerSession) {
      throw new OrchestrationError('workflow_limit_reached', `A session may have at most ${this.maxPerSession} active workflows.`);
    }
    this.prune();
    const request: WorkflowExecutionRequest = {
      id: `wf_${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
      providerId: input.providerId,
      model: input.model,
      args,
      definition: materialized,
      createdAt: new Date().toISOString()
    };
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const live: LiveWorkflow = {
      request,
      snapshot: createInitialWorkflowSnapshot(request),
      controller: new AbortController(),
      done,
      resolveDone,
      settled: false,
      cancelRequested: false,
      persistenceWrites: Promise.resolve(),
      persistenceError: undefined,
      definitionHashMatches: true
    };
    this.workflows.set(request.id, live);
    this.notify(live);
    void this.execute(live);
    return cloneSnapshot(live.snapshot);
  }

  async restore(): Promise<WorkflowRunSnapshot[]> {
    if (!this.persistence) return [];
    const restored: WorkflowRunSnapshot[] = [];
    for (const persisted of await this.persistence.list()) {
      if (this.workflows.has(persisted.snapshot.id)) continue;
      const previous = persisted.snapshot;
      let snapshot = previous;
      if (!TERMINAL_STATES.has(previous.state)) {
        snapshot = {
          ...previous,
          state: 'interrupted',
          revision: previous.revision + 1,
          finishedAt: new Date().toISOString(),
          steps: previous.steps.map((step) => ['running', 'queued'].includes(step.state)
            ? { ...step, state: 'interrupted', finishedAt: new Date().toISOString(), incomplete: true }
            : step),
          incomplete: true,
          error: 'Workflow execution was interrupted before the process exited.',
          errorCode: 'workflow_interrupted'
        };
        await this.persistence.appendTransition(previous, snapshot);
      }
      const live: LiveWorkflow = {
        request: persisted.request,
        snapshot,
        controller: undefined,
        done: Promise.resolve(),
        resolveDone: () => undefined,
        settled: true,
        cancelRequested: false,
        persistenceWrites: Promise.resolve(),
        persistenceError: undefined,
        definitionHashMatches: persisted.definitionHashMatches,
        persistedDefinitionHash: persisted.request.definitionHash
      };
      this.workflows.set(snapshot.id, live);
      this.notify(live);
      restored.push(cloneSnapshot(snapshot));
    }
    return restored;
  }

  resume(id: string): WorkflowRunSnapshot {
    const live = this.workflows.get(id);
    if (!live) throw new OrchestrationError('workflow_not_found', `Workflow not found: ${id}`);
    if (!live.definitionHashMatches
      || (live.persistedDefinitionHash !== undefined
        && this.persistence?.definitionHash(live.request.definition) !== live.persistedDefinitionHash)) {
      throw new OrchestrationError('workflow_resume_mismatch', 'The persisted workflow definition no longer matches its definition hash.');
    }
    try {
      resolveWorkflowArgs(live.request.definition.inputs, live.request.args);
    } catch {
      throw new OrchestrationError('workflow_resume_mismatch', 'The persisted workflow args no longer match the definition inputs.');
    }
    if (!['interrupted', 'failed', 'timed_out', 'cancelled'].includes(live.snapshot.state)) {
      throw new OrchestrationError('workflow_resume_invalid_state', `Workflow cannot resume from state: ${live.snapshot.state}`);
    }
    const previous = cloneSnapshot(live.snapshot);
    let resolveDone: () => void = () => undefined;
    live.done = new Promise<void>((resolve) => { resolveDone = resolve; });
    live.resolveDone = resolveDone;
    live.controller = new AbortController();
    live.settled = false;
    live.cancelRequested = false;
    live.persistenceError = undefined;
    const next = createResumedWorkflowSnapshot(live.request, previous);
    live.snapshot = next;
    this.persist(live, () => this.persistence!.appendTransition(previous, next));
    this.notify(live);
    void this.execute(live, previous, false);
    return cloneSnapshot(live.snapshot);
  }

  async wait(id: string, signal: AbortSignal, timeoutMs: number): Promise<WorkflowRunSnapshot> {
    const live = this.workflows.get(id);
    if (!live) throw new OrchestrationError('workflow_not_found', `Workflow not found: ${id}`);
    if (signal.aborted) throw abortError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs);
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([live.done, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    return cloneSnapshot(live.snapshot);
  }

  get(id: string): WorkflowRunSnapshot | undefined {
    const live = this.workflows.get(id);
    return live ? cloneSnapshot(live.snapshot) : undefined;
  }

  workingDirectory(id: string): string | undefined {
    return this.workflows.get(id)?.request.workingDirectory;
  }

  list(sessionId: string): WorkflowRunSnapshot[] {
    return [...this.workflows.values()]
      .filter((workflow) => workflow.snapshot.sessionId === sessionId)
      .map((workflow) => cloneSnapshot(workflow.snapshot));
  }

  listSaved(workingDirectory: string): SavedWorkflowSummary[] {
    return this.savedWorkflows?.summarize(workingDirectory) ?? [];
  }

  cancel(id: string): WorkflowRunSnapshot {
    const live = this.workflows.get(id);
    if (!live) throw new OrchestrationError('workflow_not_found', `Workflow not found: ${id}`);
    if (live.settled) return cloneSnapshot(live.snapshot);
    live.cancelRequested = true;
    live.controller?.abort();
    const previous = live.snapshot;
    const next = {
      ...live.snapshot,
      state: 'cancelled' as const,
      revision: live.snapshot.revision + 1,
      errorCode: 'workflow_cancelled' as const,
      error: 'Workflow was cancelled.',
      incomplete: true
    };
    live.snapshot = next;
    this.persist(live, () => this.persistence!.appendTransition(previous, next));
    this.notify(live);
    return cloneSnapshot(live.snapshot);
  }

  cancelSession(sessionId: string): void {
    for (const workflow of this.workflows.values()) {
      if (workflow.snapshot.sessionId === sessionId) this.cancel(workflow.snapshot.id);
    }
  }

  async quiesceSession(sessionId: string): Promise<void> {
    const workflows = [...this.workflows.values()].filter((workflow) => workflow.snapshot.sessionId === sessionId);
    for (const workflow of workflows) {
      if (!workflow.settled) this.cancel(workflow.snapshot.id);
    }
    await Promise.all(workflows.map((workflow) => workflow.done));
    await Promise.all(workflows.map(async (workflow) => {
      await workflow.persistenceWrites;
      if (workflow.persistenceError) throw workflow.persistenceError;
    }));
  }

  private resolveDefinition(input: WorkflowStartRequest) {
    const hasDefinition = input.definition !== undefined;
    const hasName = input.name !== undefined && input.name !== '';
    if (hasDefinition === hasName) {
      throw new OrchestrationError('workflow_invalid_definition', 'Provide exactly one of definition or name.');
    }
    if (hasName) {
      if (!this.savedWorkflows) {
        throw new OrchestrationError('saved_workflow_not_found', `Unknown saved workflow: ${input.name}`);
      }
      return this.savedWorkflows.get(input.name!, input.workingDirectory).definition;
    }
    const parsed = parseDefinition(input.definition);
    if (!parsed.success) throw new OrchestrationError('workflow_invalid_definition', parsed.error.message, parsed.error.issues);
    return parsed.data;
  }

  private async execute(live: LiveWorkflow, initialSnapshot?: WorkflowRunSnapshot, createJournal = true): Promise<void> {
    try {
      if (createJournal && this.persistence) await this.persistence.create(live.request, live.snapshot);
      const controller = live.controller;
      if (!controller) throw new OrchestrationError('workflow_step_failed', 'Workflow execution controller is unavailable.');
      const final = await this.engine.run(live.request, controller.signal, {
        onChanged: (snapshot) => {
          if (live.settled) return;
          const previous = live.snapshot;
          const revision = snapshot.revision <= live.snapshot.revision
            ? live.snapshot.revision + 1
            : snapshot.revision;
          const next: WorkflowRunSnapshot = live.cancelRequested && snapshot.state === 'running'
            ? { ...snapshot, revision, state: 'cancelled', incomplete: true }
            : { ...snapshot, revision };
          live.snapshot = next;
          this.persist(live, () => this.persistence!.appendTransition(previous, next));
          this.notify(live);
        },
        onLog: (event) => {
          this.emit(event);
          this.persist(live, () => this.persistence!.appendLog(event));
        }
      }, initialSnapshot);
      if (final.revision > live.snapshot.revision) live.snapshot = final;
      await live.persistenceWrites;
      if (live.persistenceError) throw live.persistenceError;
    } catch (error) {
      const previous = live.snapshot;
      const persistenceFailed = error === live.persistenceError;
      const next: WorkflowRunSnapshot = {
        ...live.snapshot,
        state: live.cancelRequested ? 'cancelled' : 'failed',
        revision: live.snapshot.revision + 1,
        finishedAt: new Date().toISOString(),
        errorCode: live.cancelRequested ? 'workflow_cancelled' : persistenceFailed ? 'workflow_persistence_failed' : 'workflow_step_failed',
        error: error instanceof Error ? error.message : String(error),
        incomplete: true
      };
      live.snapshot = next;
      this.persist(live, () => this.persistence!.appendTransition(previous, next));
      this.notify(live);
    } finally {
      live.settled = true;
      live.controller = undefined;
      live.resolveDone();
    }
  }

  private notify(live: LiveWorkflow): void {
    this.emit({ type: 'workflow.changed', workflow: cloneSnapshot(live.snapshot) });
  }

  private persist(live: LiveWorkflow, operation: () => Promise<void>): void {
    if (!this.persistence) return;
    live.persistenceWrites = live.persistenceWrites
      .then(operation)
      .catch((error: unknown) => {
        live.persistenceError ??= error instanceof Error ? error : new Error(String(error));
      });
  }

  private prune(): void {
    const terminal = [...this.workflows.values()]
      .filter((workflow) => TERMINAL_STATES.has(workflow.snapshot.state))
      .sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt));
    for (const workflow of terminal.slice(0, Math.max(0, terminal.length - this.retention + 1))) {
      this.workflows.delete(workflow.snapshot.id);
    }
  }
}
