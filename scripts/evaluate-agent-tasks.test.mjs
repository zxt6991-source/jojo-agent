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

const v2 = overrides => ({ ...run('passed'), schemaVersion: 2, fixtureHash: '1'.repeat(64), dirtyTreeHash: '2'.repeat(64), ...overrides });
test('keeps tasks and dirty source variants in separate groups', () => {
  assert.equal(summarizeTaskRuns([run('passed'), { ...run('passed'), runId: 'other', taskId: 'recall' }]).length, 2);
  assert.equal(summarizeTaskRuns([v2({}), v2({ runId: 'dirty', dirtyTreeHash: '3'.repeat(64) })]).length, 2);
});
test('distinguishes missing measurements from measured zero and reports coverage', () => {
  const [group] = summarizeTaskRuns([v2({ costUsd: null, inputTokens: null, metricReasons: { costUsd: 'usage unavailable', inputTokens: 'usage unavailable' } }), v2({ runId: 'zero', costUsd: 0, inputTokens: null, metricReasons: { inputTokens: 'usage unavailable' } })]);
  assert.equal(group.totals.costUsd, 0);
  assert.equal(group.totals.inputTokens, null);
  assert.deepEqual(group.metricCoverage.costUsd, { knownSamples: 1, missingSamples: 1 });
  assert.deepEqual(group.metricCoverage.inputTokens, { knownSamples: 0, missingSamples: 2 });
  assert.throws(() => summarizeTaskRuns([v2({ costUsd: null })]));
});
test('unresolved criteria cannot yield a passed score', () => {
  const criteria = [{ id: 'review', passed: null, reason: 'Requires human review', evidence: 'trace#1' }];
  assert.throws(() => summarizeTaskRuns([v2({ criteria })]));
  const [group] = summarizeTaskRuns([v2({ status: 'failed', failureCategory: 'unresolved', criteria })]);
  assert.equal(group.successRate, 0);
});

test('refuses pending or invalid source identity as scored task success', () => {
  assert.throws(() => summarizeTaskRuns([v2({ sourceValidity: 'pending' })]));
  assert.throws(() => summarizeTaskRuns([v2({ sourceValidity: 'invalid' })]));
  assert.equal(summarizeTaskRuns([v2({ sourceValidity: 'verified' })])[0].passed, 1);
  assert.equal(summarizeTaskRuns([v2({ sourceValidity: 'invalid', status: 'infrastructure_error', failureCategory: 'source_changed' })])[0].infrastructureErrors, 1);
});
