import process from 'node:process';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function summarizeTaskRuns(runs) {
  if (!Array.isArray(runs)) throw new Error('Expected an array of scored task runs.');
  const ids = new Set();
  const metrics = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelCalls', 'toolCalls', 'userTurns', 'elapsedMs', 'costUsd'];
  const groups = new Map();
  for (const run of runs) {
    if (!run || typeof run.runId !== 'string' || ids.has(run.runId)) throw new Error('Missing or duplicate runId.');
    ids.add(run.runId);
    const version = run.schemaVersion ?? 1;
    if (![1, 2].includes(version)) throw new Error(`Unsupported schemaVersion: ${run.runId}`);
    for (const field of ['taskId', 'variant', 'provider', 'model', 'checkout', 'settingsHash', 'tracePath']) {
      if (typeof run[field] !== 'string' || !run[field]) throw new Error(`Missing ${field}: ${run.runId}`);
    }
    if (version === 2) for (const field of ['fixtureHash', 'dirtyTreeHash']) {
      if (typeof run[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(run[field])) throw new Error(`Missing ${field}: ${run.runId}`);
    }
    if (version === 2 && run.sourceValidity !== undefined && !(run.sourceValidity === 'verified' || run.sourceValidity === 'invalid' && run.status === 'infrastructure_error')) throw new Error(`Unverified source identity: ${run.runId}`);
    if (!['passed', 'failed', 'infrastructure_error'].includes(run.status)) throw new Error(`Invalid status: ${run.runId}`);
    if (run.status !== 'passed' && (typeof run.failureCategory !== 'string' || !run.failureCategory)) throw new Error(`Missing failure category: ${run.runId}`);
    if (!Array.isArray(run.criteria) || !run.criteria.length || run.criteria.some(item => !item || typeof item.id !== 'string' || !(typeof item.passed === 'boolean' || version === 2 && item.passed === null && typeof item.reason === 'string' && item.reason.trim()) || typeof item.evidence !== 'string' || !item.evidence)) throw new Error(`Missing scored evidence: ${run.runId}`);
    if (run.status === 'passed' && run.criteria.some(item => !item.passed)) throw new Error(`False passed score: ${run.runId}`);
    if (new Set(run.criteria.map(item => item.id)).size !== run.criteria.length) throw new Error(`Duplicate criterion: ${run.runId}`);
    const key = JSON.stringify([version, run.taskId, run.variant, run.provider, run.model, run.settingsHash, run.checkout, run.fixtureHash, run.dirtyTreeHash]);
    const group = groups.get(key) ?? { schemaVersion: version, taskId: run.taskId, ...(version === 2 ? { fixtureHash: run.fixtureHash, dirtyTreeHash: run.dirtyTreeHash } : {}), variant: run.variant, provider: run.provider, model: run.model, settingsHash: run.settingsHash, checkout: run.checkout, passed: 0, failed: 0, infrastructureErrors: 0, totals: Object.fromEntries(metrics.map(field => [field, 0])), metricCoverage: Object.fromEntries(metrics.map(field => [field, { knownSamples: 0, missingSamples: 0 }])), failureCategories: {} };
    if (run.status === 'infrastructure_error') group.infrastructureErrors++;
    else group[run.status]++;
    if (run.failureCategory) group.failureCategories[run.failureCategory] = (group.failureCategories[run.failureCategory] ?? 0) + 1;
    for (const field of metrics) {
      if (version === 2 && run[field] === null) {
        if (typeof run.metricReasons?.[field] !== 'string' || !run.metricReasons[field].trim()) throw new Error(`Missing metric reason ${field}: ${run.runId}`);
        group.metricCoverage[field].missingSamples++;
        continue;
      }
      if (typeof run[field] !== 'number' || !Number.isFinite(run[field]) || run[field] < 0) throw new Error(`Missing or invalid metric ${field}: ${run.runId}`);
      group.metricCoverage[field].knownSamples++;
      group.totals[field] += run[field];
    }
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, totals: Object.fromEntries(metrics.map(field => [field, group.metricCoverage[field].knownSamples ? group.totals[field] : null])), scoredRuns: group.passed + group.failed, successRate: group.passed + group.failed ? group.passed / (group.passed + group.failed) : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/evaluate-agent-tasks.mjs scored-runs.json');
  console.log(JSON.stringify(summarizeTaskRuns(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2));
}
