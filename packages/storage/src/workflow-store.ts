import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  WorkflowJournalRecordSchema,
  type OrchestrationEvent,
  type StoredWorkflowRequest,
  type WorkflowDefinition,
  type WorkflowJournalRecord,
  type WorkflowJournalRecordType,
  type WorkflowRunSnapshot,
  type WorkflowStepState
} from '@desktop-agent/contracts';

type WorkflowExecutionRequest = Omit<StoredWorkflowRequest, 'definitionHash'>;
type PersistedWorkflowRun = {
  request: StoredWorkflowRequest;
  snapshot: WorkflowRunSnapshot;
  warnings: string[];
  definitionHashMatches: boolean;
};

export const MAX_WORKFLOW_JOURNAL_BYTES = 10 * 1024 * 1024;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function workflowDefinitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(stableJson(definition)).digest('hex');
}

function workflowRecordType(state: WorkflowRunSnapshot['state']): WorkflowJournalRecordType {
  return state === 'completed' ? 'workflow.completed'
    : state === 'failed' ? 'workflow.failed'
      : state === 'cancelled' ? 'workflow.cancelled'
        : state === 'timed_out' ? 'workflow.timed_out'
          : state === 'interrupted' ? 'workflow.interrupted'
            : 'workflow.updated';
}

function stepRecordType(state: WorkflowStepState): WorkflowJournalRecordType {
  return state === 'running' ? 'step.started'
    : state === 'completed' ? 'step.completed'
      : state === 'failed' ? 'step.failed'
        : state === 'cancelled' ? 'step.cancelled'
          : state === 'timed_out' ? 'step.timed_out'
            : state === 'blocked' ? 'step.blocked'
              : 'workflow.updated';
}

function transitionRecord(previous: WorkflowRunSnapshot, next: WorkflowRunSnapshot): WorkflowJournalRecord {
  const changedStep = next.steps.find((step) => {
    const prior = previous.steps.find((item) => item.id === step.id);
    return prior?.state !== step.state || prior.attempt !== step.attempt;
  });
  const priorStep = changedStep ? previous.steps.find((step) => step.id === changedStep.id) : undefined;
  const retrying = Boolean(changedStep && priorStep
    && changedStep.state === 'queued'
    && changedStep.attempt > priorStep.attempt);
  const type = retrying ? 'step.retrying' : changedStep ? stepRecordType(changedStep.state) : workflowRecordType(next.state);
  return {
    schemaVersion: 1,
    type,
    runId: next.id,
    createdAt: new Date().toISOString(),
    snapshot: next,
    ...(changedStep && type.startsWith('step.') ? { stepId: changedStep.id } : {})
  };
}

export class JsonlWorkflowStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  definitionHash(definition: WorkflowDefinition): string {
    return workflowDefinitionHash(definition);
  }

  create(request: WorkflowExecutionRequest, snapshot: WorkflowRunSnapshot): Promise<void> {
    const storedRequest: StoredWorkflowRequest = {
      ...request,
      definitionHash: this.definitionHash(request.definition)
    };
    return this.enqueue(request.id, {
      schemaVersion: 1,
      type: 'workflow.started',
      runId: request.id,
      createdAt: request.createdAt,
      request: storedRequest,
      snapshot
    });
  }

  appendTransition(previous: WorkflowRunSnapshot, next: WorkflowRunSnapshot): Promise<void> {
    return this.enqueue(next.id, transitionRecord(previous, next));
  }

  appendLog(event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): Promise<void> {
    return this.enqueue(event.runId, {
      schemaVersion: 1,
      type: 'workflow.log',
      runId: event.runId,
      createdAt: event.createdAt,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      level: event.level,
      message: event.message
    });
  }

  async load(runId: string): Promise<PersistedWorkflowRun | null> {
    let content: string;
    try { content = await readFile(this.file(runId), 'utf8'); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let request: StoredWorkflowRequest | undefined;
    let snapshot: WorkflowRunSnapshot | undefined;
    const warnings: string[] = [];
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch { warnings.push(`Ignored incomplete or invalid record at line ${index + 1}.`); continue; }
      const parsed = WorkflowJournalRecordSchema.safeParse(raw);
      if (!parsed.success) { warnings.push(`Ignored unsupported record at line ${index + 1}.`); continue; }
      request = parsed.data.request ?? request;
      snapshot = parsed.data.snapshot ?? snapshot;
    }
    if (!request || !snapshot) return null;
    const definitionHashMatches = workflowDefinitionHash(request.definition) === request.definitionHash;
    if (!definitionHashMatches) {
      warnings.push('Definition hash does not match the persisted workflow definition.');
    }
    return { request, snapshot, warnings, definitionHashMatches };
  }

  async list(): Promise<PersistedWorkflowRun[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => /^wf_[a-zA-Z0-9_-]+\.jsonl$/u.test(file));
    const runs = await Promise.all(files.map((file) => this.load(file.slice(0, -6))));
    return runs.filter((run): run is PersistedWorkflowRun => run !== null)
      .sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt));
  }

  private file(runId: string): string {
    if (!/^wf_[a-zA-Z0-9_-]+$/u.test(runId)) throw new Error('Invalid workflow run id.');
    return path.join(this.directory, `${runId}.jsonl`);
  }

  private enqueue(runId: string, record: WorkflowJournalRecord): Promise<void> {
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = this.file(runId);
      let size = 0;
      try { size = (await stat(file)).size; } catch { /* first record */ }
      const line = `${JSON.stringify(WorkflowJournalRecordSchema.parse(record))}\n`;
      if (size + Buffer.byteLength(line) > MAX_WORKFLOW_JOURNAL_BYTES) {
        throw new Error(`workflow_journal_limit: Journal exceeds ${MAX_WORKFLOW_JOURNAL_BYTES} bytes.`);
      }
      await appendFile(file, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    });
    this.writes.set(runId, next);
    void next.finally(() => { if (this.writes.get(runId) === next) this.writes.delete(runId); }).catch(() => undefined);
    return next;
  }
}
