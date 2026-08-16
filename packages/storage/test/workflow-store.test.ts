import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowRunSnapshot } from '@desktop-agent/contracts';
import { JsonlWorkflowStore } from '../src/index.js';

const definition = {
  schemaVersion: 1 as const,
  name: 'persisted workflow',
  maxConcurrency: 2,
  timeoutMs: 60_000,
  steps: [{
    id: 'inspect', type: 'agent' as const, profile: 'explore' as const,
    task: 'Inspect', dependsOn: [], timeoutMs: 30_000, continueOnError: false
  }]
};

function runningSnapshot(createdAt: string): WorkflowRunSnapshot {
  return {
    id: 'wf_store', sessionId: 'session', name: definition.name, state: 'running', revision: 0,
    createdAt, startedAt: createdAt,
    steps: [{ id: 'inspect', state: 'running', attempt: 1, createdAt, startedAt: createdAt, incomplete: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 } }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    failedStepIds: [], blockedStepIds: [], incomplete: false
  };
}

describe('JsonlWorkflowStore', () => {
  it('appends auditable records and recovers from an incomplete tail', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-store-'));
    const store = new JsonlWorkflowStore(directory);
    const createdAt = new Date().toISOString();
    const initial = runningSnapshot(createdAt);
    await store.create({
      id: initial.id, sessionId: initial.sessionId, workingDirectory: '/tmp/project',
      providerId: 'provider', model: 'model', definition, createdAt
    }, initial);
    const completed: WorkflowRunSnapshot = {
      ...initial,
      state: 'completed', revision: 1, finishedAt: new Date().toISOString(), result: 'evidence',
      steps: [{ ...initial.steps[0]!, state: 'completed', output: 'evidence', finishedAt: new Date().toISOString(),
        usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 0 } }],
      usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 0 }
    };
    await Promise.all([
      store.appendTransition(initial, completed),
      store.appendLog({ type: 'workflow.log', runId: initial.id, stepId: 'inspect', level: 'info', message: 'done', createdAt: new Date().toISOString() })
    ]);
    const file = path.join(directory, 'wf_store.jsonl');
    await appendFile(file, '{"schemaVersion":1,"type":"workflow.updated"');

    const loaded = await store.load(initial.id);
    expect(loaded?.snapshot).toMatchObject({ state: 'completed', result: 'evidence' });
    expect(loaded?.request.definitionHash).toBe(store.definitionHash(definition));
    expect(loaded?.definitionHashMatches).toBe(true);
    expect(loaded?.warnings).toHaveLength(1);
    const records = (await readFile(file, 'utf8')).split('\n').filter((line) => line.endsWith('}')).map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(['workflow.started', 'step.completed', 'workflow.log']);
  });
});
