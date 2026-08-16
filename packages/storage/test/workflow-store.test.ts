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
      providerId: 'provider', model: 'model', args: { target: 'src' }, definition, createdAt
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
    expect(loaded?.request.args).toEqual({ target: 'src' });
    expect(loaded?.definitionHashMatches).toBe(true);
    expect(loaded?.warnings).toHaveLength(1);
    const records = (await readFile(file, 'utf8')).split('\n').filter((line) => line.endsWith('}')).map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(['workflow.started', 'step.completed', 'workflow.log']);
  });

  it('records an attempt increment as step.retrying', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-store-retry-'));
    const store = new JsonlWorkflowStore(directory);
    const createdAt = new Date().toISOString();
    const running = runningSnapshot(createdAt);
    const failed: WorkflowRunSnapshot = {
      ...running,
      revision: 1,
      steps: [{
        ...running.steps[0]!, state: 'failed', errorCode: 'provider_error', error: 'Retry later.',
        incomplete: true, finishedAt: new Date().toISOString()
      }]
    };
    const retrying: WorkflowRunSnapshot = {
      ...failed,
      revision: 2,
      steps: [{
        id: 'inspect', state: 'queued', attempt: 2, createdAt,
        startedAt: createdAt, incomplete: false, usage: { ...failed.steps[0]!.usage }
      }]
    };
    await store.create({
      id: running.id, sessionId: running.sessionId, workingDirectory: '/tmp/project',
      providerId: 'provider', model: 'model', args: {}, definition, createdAt
    }, running);
    await store.appendTransition(running, failed);
    await store.appendTransition(failed, retrying);

    const records = (await readFile(path.join(directory, 'wf_store.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual([
      'workflow.started', 'step.failed', 'step.retrying'
    ]);
    expect(records[2]).toMatchObject({ stepId: 'inspect', snapshot: { steps: [{ attempt: 2 }] } });
  });
});
