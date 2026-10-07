import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTaskRuns } from './evaluate-agent-tasks.mjs';
const run = status => ({ runId: status, taskId: 'repair', variant: 'baseline', provider: 'fixed', model: 'fixed', checkout: 'sha', settingsHash: 'hash', tracePath: 'trace.json', status, ...(status !== 'passed' ? { failureCategory: 'execution' } : {}), criteria: [{ id: 'valid', passed: status === 'passed', evidence: 'trace#1' }], inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 1, toolCalls: 2, userTurns: 1, elapsedMs: 100, costUsd: 0 });
test('failed tasks stay in accuracy denominator and infrastructure errors stay separate', () => {
  const [result] = summarizeTaskRuns([run('passed'), run('failed'), run('infrastructure_error')]);
  assert.equal(result.successRate, 0.5);
  assert.equal(result.infrastructureErrors, 1);
  assert.equal(result.totals.toolCalls, 6);
});
test('rejects false pass claims, duplicated runs and unknown metrics', () => {
  assert.throws(() => summarizeTaskRuns([{ ...run('passed'), criteria: [{ id: 'bad', passed: false, evidence: 'trace' }] }]));
  assert.throws(() => summarizeTaskRuns([run('passed'), run('passed')]));
  assert.throws(() => summarizeTaskRuns([{ ...run('failed'), inputTokens: undefined }]));
});
