import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredWorkflowRequest, ToolContext, WorkflowDefinition } from '@desktop-agent/contracts';
import { WorkflowDefinitionSchema } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  BUILTIN_SAVED_WORKFLOWS,
  createBuiltinSavedWorkflowRegistry,
  createWorkflowTools,
  emptyUsage,
  interpolateWorkflowPlaceholders,
  loadSavedWorkflowDirectory,
  materializeWorkflowDefinition,
  reloadSavedWorkflows,
  resolveWorkflowArgs,
  WRITE_CAPABLE_AGENT_TOOLS,
  WorkflowEngine,
  WorkflowManager,
  type LeafAgentRunner,
  type PersistedWorkflowRun,
  type WorkflowExecutionRequest,
  type WorkflowPersistence
} from '../src/index.js';

class MemoryWorkflowPersistence implements WorkflowPersistence {
  runs: PersistedWorkflowRun[] = [];
  definitionHash(_definition: WorkflowDefinition): string { return 'a'.repeat(64); }
  async create(request: WorkflowExecutionRequest, snapshot: PersistedWorkflowRun['snapshot']): Promise<void> {
    this.runs.push({
      request: { ...request, definitionHash: this.definitionHash(request.definition) },
      snapshot, warnings: [], definitionHashMatches: true
    });
  }
  async appendTransition(_previous: PersistedWorkflowRun['snapshot'], next: PersistedWorkflowRun['snapshot']): Promise<void> {
    const run = this.runs.find((item) => item.snapshot.id === next.id);
    if (run) run.snapshot = next;
  }
  async appendLog(): Promise<void> {}
  async load(runId: string): Promise<PersistedWorkflowRun | null> {
    return this.runs.find((item) => item.snapshot.id === runId) ?? null;
  }
  async list(): Promise<PersistedWorkflowRun[]> { return this.runs; }
}

function yamlWorkflow(name: string, extra = 'task: Inspect {{inputs.target}}'): string {
  return [
    'schemaVersion: 1',
    `name: ${name}`,
    `description: Saved ${name}`,
    'inputs:',
    '  target:',
    '    type: string',
    '    required: true',
    'steps:',
    '  - id: inspect',
    '    type: agent',
    '    profile: explore',
    `    ${extra}`
  ].join('\n');
}

describe('workflow args and placeholders', () => {
  it('applies defaults, rejects type errors, and interpolates only inputs placeholders', () => {
    const definitions = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'parameterized',
      inputs: {
        target: { type: 'string', required: true },
        deep: { type: 'boolean', default: false }
      },
      steps: [{ id: 'a', type: 'agent', task: 'Inspect {{inputs.target}} deep={{inputs.deep}}' }]
    }).inputs;
    expect(resolveWorkflowArgs(definitions, { target: 'src' })).toEqual({ target: 'src', deep: false });
    expect(() => resolveWorkflowArgs(definitions, { target: 1 }))
      .toThrowError(expect.objectContaining({ code: 'workflow_invalid_args' }));
    expect(() => resolveWorkflowArgs(definitions, {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_invalid_args' }));
    expect(() => resolveWorkflowArgs(definitions, { target: 'src', extra: true }))
      .toThrowError(expect.objectContaining({ code: 'workflow_invalid_args' }));

    const materialized = materializeWorkflowDefinition(
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'parameterized',
        steps: [{ id: 'a', type: 'agent', task: 'Inspect {{inputs.target}}' }]
      }),
      { target: 'packages/orchestration' }
    );
    expect(materialized.steps[0]).toMatchObject({ task: 'Inspect packages/orchestration' });
    expect(() => interpolateWorkflowPlaceholders('Inspect {{inputs.missing}}', { target: 'src' }))
      .toThrowError(expect.objectContaining({ code: 'workflow_reference_not_found' }));
    expect(() => interpolateWorkflowPlaceholders('Inspect {{foo}}', {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_invalid_args' }));
  });
});

describe('saved workflow loader', () => {
  it('loads valid YAML, isolates broken files, and requires name/file matches', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'saved-workflows-'));
    await writeFile(path.join(directory, 'repo-map.yaml'), yamlWorkflow('repo-map'));
    await writeFile(path.join(directory, 'broken.yaml'), 'not: [valid');
    await writeFile(path.join(directory, 'wrong.yaml'), yamlWorkflow('different'));

    const result = await loadSavedWorkflowDirectory(directory, 'user');
    expect(result.workflows).toMatchObject([{ name: 'repo-map', source: 'user' }]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.message.includes('must match its file name'))).toBe(true);
  });

  it('applies project > user > builtin precedence and reloads without mutating started copies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'saved-workflow-project-'));
    const userDirectory = path.join(root, 'user');
    const projectRoot = path.join(root, 'project');
    const projectDirectory = path.join(projectRoot, '.jojo', 'workflows');
    await mkdir(userDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(userDirectory, 'repo-understand.yaml'), yamlWorkflow('repo-understand', 'task: User {{inputs.target}}'));
    await writeFile(path.join(projectDirectory, 'repo-understand.yaml'), yamlWorkflow('repo-understand', 'task: Project {{inputs.target}}'));

    const registry = createBuiltinSavedWorkflowRegistry();
    await reloadSavedWorkflows(registry, { userDirectory, projectRoot });
    expect(registry.get('repo-understand').source).toBe('user');
    expect(registry.get('repo-understand', projectRoot)).toMatchObject({ source: 'project' });
    const started = registry.get('repo-understand', projectRoot);
    await writeFile(path.join(projectDirectory, 'repo-understand.yaml'), yamlWorkflow('repo-understand', 'task: Updated {{inputs.target}}'));
    await reloadSavedWorkflows(registry, { projectRoot });
    expect(registry.get('repo-understand', projectRoot).definition.steps[0]).toMatchObject({ task: 'Updated {{inputs.target}}' });
    expect(started.definition.steps[0]).toMatchObject({ task: 'Project {{inputs.target}}' });
  });
});

describe('builtin saved workflows', () => {
  it('ships repo-understand, architecture-review, and code-review without extra permissions', () => {
    expect(BUILTIN_SAVED_WORKFLOWS.map((workflow) => workflow.name)).toEqual([
      'repo-understand', 'architecture-review', 'code-review'
    ]);
    for (const definition of BUILTIN_SAVED_WORKFLOWS) {
      for (const step of definition.steps) {
        if (step.type === 'agent') {
          expect(step.profile).not.toBe('general');
          expect(step.tools?.allow?.some((name) => WRITE_CAPABLE_AGENT_TOOLS.has(name)) ?? false).toBe(false);
        }
        if (step.type === 'tool') expect(WRITE_CAPABLE_AGENT_TOOLS.has(step.tool)).toBe(false);
      }
    }
  });
});

describe('WorkflowManager saved workflows', () => {
  it('starts a saved workflow by name, interpolates args, and lists the catalog', async () => {
    const tasks: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (request) => {
        tasks.push(request.task);
        return { result: '{"summary":"ok","findings":["finding"]}', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    };
    const manager = new WorkflowManager(
      new WorkflowEngine(runner, new AgentExecutionScheduler(3)),
      () => undefined,
      { savedWorkflows: createBuiltinSavedWorkflowRegistry() }
    );
    const started = manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model',
      name: 'architecture-review', args: { target: 'packages/orchestration' }
    });
    const final = await manager.wait(started.id, new AbortController().signal, 2_000);
    expect(final.state).toBe('completed');
    expect(tasks.some((task) => task.includes('packages/orchestration'))).toBe(true);
    expect(tasks.some((task) => task.includes('{{inputs.target}}'))).toBe(false);

    const tools = createWorkflowTools(manager, { providerId: 'provider', model: 'model' });
    const context: ToolContext = {
      sessionId: 'session', workingDirectory: process.cwd(), signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    };
    const listed = await tools.find((tool) => tool.definition.name === 'workflow_list')!.execute({}, context);
    expect(listed.ok).toBe(true);
    expect(JSON.parse(listed.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'repo-understand', source: 'builtin' })
    ]));

    const named = await tools[0]!.execute({ name: 'code-review', args: { target: 'apps/desktop' } }, context);
    expect(named.ok).toBe(true);
    const missing = await tools[0]!.execute({ name: 'not-a-workflow' }, context);
    expect(missing).toMatchObject({ ok: false, code: 'saved_workflow_not_found' });
    expect(() => manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model',
      name: 'code-review', args: { target: 12 }
    })).toThrowError(expect.objectContaining({ code: 'workflow_invalid_args' }));
  });

  it('rejects resume when persisted args no longer satisfy declared inputs', async () => {
    const persistence = new MemoryWorkflowPersistence();
    const createdAt = new Date().toISOString();
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'parameterized',
      inputs: { target: { type: 'string', required: true } },
      steps: [{ id: 'a', type: 'agent', task: 'Inspect {{inputs.target}}' }]
    });
    const request: StoredWorkflowRequest = {
      id: 'wf_args', sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model',
      args: {}, definition, definitionHash: persistence.definitionHash(definition), createdAt
    };
    persistence.runs.push({
      request, warnings: [], definitionHashMatches: true,
      snapshot: {
        id: request.id, sessionId: request.sessionId, name: definition.name, state: 'interrupted', revision: 1,
        createdAt, steps: [{ id: 'a', state: 'pending', attempt: 1, createdAt, incomplete: false, usage: emptyUsage() }],
        usage: emptyUsage(), failedStepIds: [], blockedStepIds: [], incomplete: true
      }
    });
    const manager = new WorkflowManager(
      new WorkflowEngine({ run: async () => ({ result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false }) }, new AgentExecutionScheduler(1)),
      () => undefined,
      { persistence }
    );
    await manager.restore();
    expect(() => manager.resume('wf_args')).toThrowError(expect.objectContaining({ code: 'workflow_resume_mismatch' }));
  });
});
