import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { offlineFixtures } from './offline-fixtures.js';

type Task = keyof typeof offlineFixtures;
const compiler = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
async function execute(taskId: Task, override: Record<string, unknown> = {}, timeoutMs = 30000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-fixture-test-'));
  const root = path.join(directory, 'workspace');
  const store = path.join(directory, 'store');
  await mkdir(root); await mkdir(store);
  const fixture = JSON.parse(await readFile(path.resolve('evals/agent-tasks/fixtures', taskId, 'fixture.json'), 'utf8'));
  const filename = path.join(directory, 'fixture.json');
  await writeFile(filename, JSON.stringify({ ...fixture, ...override }));
  try { return await offlineFixtures[taskId](root, store, filename, timeoutMs, compiler); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
describe('independent offline task scoring', () => {
  it.each(Object.keys(offlineFixtures) as Task[])('%s uses real runtime evidence and covers all catalog criteria', async taskId => {
    const score = await execute(taskId);
    const catalog = JSON.parse(await readFile('evals/agent-tasks/tasks.json', 'utf8'));
    const required: string[] = catalog.tasks.find((task: { id: string }) => task.id === taskId).criteria;
    const diagnostic = { criteria: score.criteria, trace: score.trace.events.filter(item => item.event.type === 'run.failed'), tools: Object.values(score.trace.toolResults).map(result => ({ callId: result.callId, ok: result.ok, code: result.code, content: result.content.slice(0, 400), verification: result.verification?.status })) };
    expect(score.status, JSON.stringify(diagnostic)).toBe('passed');
    expect(score.criteria.every(item => item.passed === true)).toBe(true);
    expect(required.every(id => score.criteria.some(item => item.id === id))).toBe(true);
    expect(score.toolCalls).toBeGreaterThan(0);
    expect(score.inputTokens).toBeNull();
    expect(score.costUsd).toBe(0);
  }, 30000);

  it('fails a long-output score when the window never reaches the original error', async () => {
    const score = await execute('middle-failure', { offset: 0 });
    expect(score.status).toBe('failed');
    expect(score.criteria.find(item => item.id === 'middle-error-found')?.passed).toBe(false);
    expect(score.trace.toolResults.long).toMatchObject({ ok: false, code: 'nonzero_exit' });
  });
  it('keeps a timeout in the failed denominator and preserves its ledger', async () => {
    const score = await execute('verification-cancel', {}, 1);
    expect(score.status).toBe('failed');
    expect(score.failureCategory).toBe('timeout');
    expect(score.trace.timedOut).toBe(true);
    expect(score.modelCalls).toBeGreaterThan(0);
  });
  it('rejects a claimed repair that still fails the installed compiler', async () => {
    const score = await execute('ts-repair', { after: 'export const value: string = 2;\n' });
    expect(score.status).toBe('failed');
    expect(score.criteria.find(item => item.id === 'final-checks-current')?.passed).toBe(false);
  }, 30000);
  it('requires actual compaction rather than successful Skill loading alone', async () => {
    const score = await execute('skill-compaction', { noiseFiles: 1, noiseCharacters: 1000, contextWindowTokens: 32000 });
    expect(score.status).toBe('failed');
    expect(score.criteria.find(item => item.id === 'exact-skill-revision')?.passed).toBe(false);
  });
  it('does not claim source recovery when only scheduled noise matches', async () => {
    const score = await execute('scheduler-noise', { query: 'unrelatedquery' });
    expect(score.status).toBe('failed');
    expect(score.criteria.find(item => item.id === 'source-entry')?.passed).toBe(false);
  });
});
