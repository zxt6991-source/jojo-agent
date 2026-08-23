import { describe, expect, it, vi } from 'vitest';
import type {
  OrchestrationEvent,
  StoredWorkflowRequest,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  type LeafAgentRunRequest,
  type LeafAgentRunner,
  type PersistedWorkflowRun,
  SubAgentManager,
  type WorkflowExecutionRequest,
  WorkflowEngine,
  WorkflowManager,
  type WorkflowPersistence
} from '../src/index.js';

const binding = {
  parentSnapshotId: 'snap_parent',
  childSnapshotId: 'snap_child',
  mode: 'project-minimal' as const
};

const workflowMemory = {
  memorySnapshotId: 'snap_frozen',
  contentHash: 'hash',
  scopeVersions: { global: 3, prj_test: 7 },
  createdAt: 1
};

function completed() {
  return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
}

class MemoryPersistence implements WorkflowPersistence {
  runs: PersistedWorkflowRun[] = [];
  definitionHash(_definition: WorkflowDefinition): string { return 'a'.repeat(64); }
  async create(request: WorkflowExecutionRequest, snapshot: WorkflowRunSnapshot): Promise<void> {
    this.runs.push({
      request: { ...request, definitionHash: this.definitionHash(request.definition) },
      snapshot, warnings: [], definitionHashMatches: true
    });
  }
  async appendTransition(_previous: WorkflowRunSnapshot, next: WorkflowRunSnapshot): Promise<void> {
    const run = this.runs.find((item) => item.snapshot.id === next.id);
    if (run) run.snapshot = next;
  }
  async appendLog(_event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): Promise<void> {}
  async load(runId: string): Promise<PersistedWorkflowRun | null> {
    return this.runs.find((item) => item.snapshot.id === runId) ?? null;
  }
  async list(): Promise<PersistedWorkflowRun[]> { return this.runs; }
}

describe('M4 orchestration memory bindings', () => {
  it('keeps a sub-agent binding stable across continuation rounds', async () => {
    const requests: LeafAgentRunRequest[] = [];
    const runner: LeafAgentRunner = {
      run: async (request) => {
        requests.push(request);
        return { ...completed(), continuationId: 'continuation_1' };
      },
      continue: vi.fn(async () => ({ ...completed(), continuationId: 'continuation_1' }))
    };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const started = manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'inspect', profile: 'explore',
      providerId: 'provider', model: 'model', timeoutMs: 10_000, memoryBinding: binding
    });
    await manager.wait([started.id], new AbortController().signal, 1_000);
    manager.send(started.id, 'continue');
    const [finished] = await manager.wait([started.id], new AbortController().signal, 1_000);
    expect(requests[0]?.memoryBinding).toEqual(binding);
    expect(finished!.memory).toEqual(binding);
  });

  it('passes one frozen workflow snapshot to every agent step', async () => {
    const requests: LeafAgentRunRequest[] = [];
    const runner: LeafAgentRunner = {
      run: async (request) => { requests.push(request); return completed(); }
    };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(2)), () => undefined);
    const started = manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model',
      memory: workflowMemory,
      definition: {
        schemaVersion: 1, name: 'frozen', steps: [
          { id: 'a', type: 'agent', task: 'A' },
          { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] }
        ]
      }
    });
    const final = await manager.wait(started.id, new AbortController().signal, 1_000);
    expect(final.memory).toEqual(workflowMemory);
    expect(final.steps.every((step) => step.memorySnapshotId === 'snap_frozen')).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.memoryBinding
      && 'memorySnapshotId' in request.memoryBinding
      && request.memoryBinding.memorySnapshotId === 'snap_frozen')).toBe(true);
  });

  it('suspends restore when the frozen durable snapshot is missing', async () => {
    const persistence = new MemoryPersistence();
    const createdAt = '2026-08-23T08:00:00.000Z';
    const definition = {
      schemaVersion: 1 as const, name: 'restore',
      maxConcurrency: 1, timeoutMs: 60_000,
      steps: [{ id: 'a', type: 'agent' as const, profile: 'explore' as const, task: 'A', dependsOn: [], continueOnError: false }]
    };
    const request: StoredWorkflowRequest = {
      id: 'wf_missing', sessionId: 'session', workingDirectory: process.cwd(),
      providerId: 'provider', model: 'model', args: {}, definition,
      definitionHash: persistence.definitionHash(definition), memory: workflowMemory, createdAt
    };
    persistence.runs.push({
      request,
      warnings: [],
      definitionHashMatches: true,
      snapshot: {
        id: request.id, sessionId: request.sessionId, name: definition.name, state: 'running', revision: 1,
        createdAt, startedAt: createdAt, memory: workflowMemory,
        steps: [{ id: 'a', state: 'running', attempt: 1, createdAt, incomplete: false, usage: emptyUsage() }],
        usage: emptyUsage(), failedStepIds: [], blockedStepIds: [], incomplete: false
      }
    });
    const manager = new WorkflowManager(
      new WorkflowEngine({ run: vi.fn() }, new AgentExecutionScheduler(1)),
      () => undefined,
      { persistence, memorySnapshotExists: async () => false }
    );
    const [restored] = await manager.restore();
    expect(restored).toMatchObject({
      state: 'suspended', errorCode: 'workflow_memory_snapshot_missing', memory: workflowMemory
    });
    expect(() => manager.resume('wf_missing')).toThrowError(expect.objectContaining({
      code: 'workflow_resume_invalid_state'
    }));
  });
});
