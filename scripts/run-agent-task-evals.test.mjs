import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceIdentity, validateOfflinePlan, completeTaskCriteria } from './run-agent-task-evals.mjs';
const exec = promisify(execFile);
const plan = { schemaVersion: 1, mode: 'offline', variant: 'fixture', tasks: ['patch-conflict'], repetitions: 2, timeoutMs: 30000, provider: 'offline-scripted', model: 'fixture-v1', costCapUsd: 0 };
test('requires a bounded offline plan and refuses unsupported coverage or paid models', () => {
  assert.deepEqual(validateOfflinePlan(plan), plan);
  for (const override of [{ tasks: ['reconnect'] }, { costCapUsd: 1 }, { mode: 'live' }, { repetitions: 0 }, { timeoutMs: 60001 }, { tasks: ['patch-conflict', 'patch-conflict'] }]) assert.throws(() => validateOfflinePlan({ ...plan, ...override }));
});
test('fingerprints dirty and new files independently of HEAD while ignoring output artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-source-identity-'));
  const git = args => exec('git', args, { cwd: root });
  try {
    await git(['init', '-q']);
    await writeFile(path.join(root, '.gitignore'), '*.log\n');
    await writeFile(path.join(root, 'source.txt'), 'baseline');
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    const before = await sourceIdentity(root);
    await writeFile(path.join(root, 'source.txt'), 'experiment');
    const changed = await sourceIdentity(root);
    assert.equal(changed.checkout, before.checkout);
    assert.notEqual(changed.dirtyTreeHash, before.dirtyTreeHash);
    await writeFile(path.join(root, 'trace.log'), 'ignored');
    assert.equal((await sourceIdentity(root)).dirtyTreeHash, changed.dirtyTreeHash);
    await writeFile(path.join(root, 'new.txt'), 'new implementation');
    assert.notEqual((await sourceIdentity(root)).dirtyTreeHash, changed.dirtyTreeHash);
    await rm(path.join(root, 'source.txt'));
    assert.ok((await sourceIdentity(root)).manifest.some(file => file.path === 'source.txt' && file.deleted));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires every catalog criterion, preserving unresolved scores and failure classification', () => {
  const original = { status: 'passed', criteria: [{ id: 'files', passed: true, evidence: 'trace.json#files' }], trace: { files: {} } };
  const incomplete = completeTaskCriteria(original, ['files', 'current-checks']);
  assert.equal(incomplete.status, 'failed');
  assert.equal(incomplete.failureCategory, 'unresolved_criteria');
  assert.equal(incomplete.criteria[1].passed, null);
  assert.deepEqual(incomplete.trace.unresolvedCriteria, ['current-checks']);
  assert.equal(completeTaskCriteria(original, ['files']).status, 'passed');
  assert.equal(completeTaskCriteria({ ...original, status: 'infrastructure_error', failureCategory: 'setup' }, ['missing']).failureCategory, 'setup');
  assert.equal(original.criteria.length, 1);
});
