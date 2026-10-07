import process from 'node:process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarizeTaskRuns } from './evaluate-agent-tasks.mjs';

const git = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Exact source identity includes uncommitted and nonignored new files; only hashes enter the report.
export async function sourceIdentity(root) {
  const { stdout: checkout } = await git('git', ['rev-parse', 'HEAD'], { cwd: root });
  const { stdout } = await git('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const manifest = [];
  let bytes = 0;
  for (const name of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    const filename = path.resolve(root, name);
    if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Source path escaped repository.');
    let info;
    try { info = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; manifest.push({ path: name, deleted: true }); continue; }
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error(`Unsupported source file: ${name}`);
    bytes += info.size;
    if (bytes > 512 * 1024 * 1024) throw new Error('Source manifest exceeds 512 MiB.');
    const content = await readFile(filename);
    manifest.push({ path: name, mode: info.mode & 0o777, hash: hash(content) });
  }
  return { checkout: checkout.trim(), dirtyTreeHash: hash(JSON.stringify(manifest)), manifest };
}

export function validateOfflinePlan(plan) {
  if (plan?.schemaVersion !== 1 || plan.mode !== 'offline' || plan.provider !== 'offline-scripted' || plan.model !== 'fixture-v1' || plan.costCapUsd !== 0) throw new Error('Only credential-free offline fixture plans are supported.');
  if (typeof plan.variant !== 'string' || !plan.variant.trim() || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.some(id => !['patch-conflict', 'middle-failure', 'verification-cancel', 'decision-recall', 'scheduler-noise', 'ts-repair', 'skill-compaction'].includes(id)) || new Set(plan.tasks).size !== plan.tasks.length) throw new Error('Plan contains tasks without an offline verifier.');
  if (!Number.isInteger(plan.repetitions) || plan.repetitions < 1 || plan.repetitions > 100 || !Number.isInteger(plan.timeoutMs) || plan.timeoutMs < 1 || plan.timeoutMs > 60000) throw new Error('Invalid repetitions or timeoutMs.');
  return plan;
}

export function completeTaskCriteria(score, requiredIds) {
  const missing = requiredIds.filter(id => !score.criteria.some(item => item.id === id));
  const criteria = [...score.criteria, ...missing.map(id => ({ id, passed: null, reason: 'The verifier did not score this required task criterion.', evidence: 'trace.json#unresolvedCriteria' }))];
  const invalidPass = score.status === 'passed' && criteria.some(item => item.passed !== true);
  return { ...score, criteria, ...(invalidPass ? { status: 'failed', failureCategory: missing.length ? 'unresolved_criteria' : 'fixture_assertion' } : {}), trace: { ...score.trace, unresolvedCriteria: missing } };
}

async function execute(planPath, output) {
  const plan = validateOfflinePlan(JSON.parse(await readFile(planPath, 'utf8')));
  const catalog = JSON.parse(await readFile(path.join(repository, 'evals/agent-tasks/tasks.json'), 'utf8'));
  const settingsHash = hash(JSON.stringify(plan));
  const identity = await sourceIdentity(repository);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Fresh output prevents an old summary from surviving a failed rerun.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'jojo-offline-evals-'));
  const require = createRequire(path.join(repository, 'apps/cli/package.json'));
  const { build } = require('esbuild');
  const config = JSON.parse(await readFile(path.join(repository, 'tsconfig.base.json'), 'utf8'));
  const aliases = new Map(Object.entries(config.compilerOptions.paths).map(([name, targets]) => [name, path.resolve(repository, targets[0])]));
  const runs = [];
  try {
    const bundle = path.join(scratch, 'fixture.mjs');
    await build({ entryPoints: [path.join(repository, 'evals/agent-tasks/offline-fixtures.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
      banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(repository, 'apps/cli/package.json'))});` },
      plugins: [{ name: 'workspace', setup(context) { context.onResolve({ filter: /^@desktop-agent\// }, args => { const target = aliases.get(args.path); return target ? { path: target } : undefined; }); } }]
    });
    const { offlineFixtures } = await import(pathToFileURL(bundle).href);
    for (const taskId of plan.tasks) {
      const fixtureFile = path.join(repository, 'evals/agent-tasks/fixtures', taskId, 'fixture.json');
      const fixtureHash = hash(await readFile(fixtureFile));
      for (let repetition = 0; repetition < plan.repetitions; repetition++) {
        const runId = randomUUID();
        const runDirectory = path.join(output, runId);
        await mkdir(runDirectory);
        const root = await mkdtemp(path.join(scratch, 'workspace-'));
        const store = await mkdtemp(path.join(scratch, 'store-'));
        let score;
        try { score = await offlineFixtures[taskId](root, store, fixtureFile, plan.timeoutMs, require.resolve('typescript/lib/tsc.js')); }
        catch (error) {
          score = { status: 'infrastructure_error', failureCategory: 'fixture_execution', criteria: [{ id: 'fixture-execution', passed: null, reason: 'Runtime fixture could not complete.', evidence: 'trace.json#error' }],
            ...Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelCalls', 'toolCalls', 'userTurns', 'elapsedMs', 'costUsd'].map(name => [name, null])),
            metricReasons: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelCalls', 'toolCalls', 'userTurns', 'elapsedMs', 'costUsd'].map(name => [name, 'Fixture execution interrupted before measurement.'])), trace: { error: error instanceof Error ? error.message : String(error) } };
        }
        const task = catalog.tasks.find(task => task.id === taskId);
        if (!task) throw new Error(`Unknown catalog task: ${taskId}`);
        score = completeTaskCriteria(score, task.criteria);
        const { trace, ...fields } = score;
        // Controlled fixtures contain no provider credentials or reasoning data. Normalize scratch paths.
        await writeFile(path.join(runDirectory, 'trace.json'), JSON.stringify(trace, null, 2).split(scratch).join('<scratch>'));
        const record = { schemaVersion: 2, runId, taskId, variant: plan.variant, provider: plan.provider, model: plan.model, checkout: identity.checkout, dirtyTreeHash: identity.dirtyTreeHash, settingsHash, fixtureHash, repetition, sourceValidity: 'pending',
          tracePath: `${runId}/trace.json`, ...fields };
        runs.push(record);
        await writeFile(path.join(output, 'runs.json'), JSON.stringify(runs, null, 2));
        await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true });
      }
    }
    const after = await sourceIdentity(repository);
    const consistent = after.dirtyTreeHash === identity.dirtyTreeHash && after.checkout === identity.checkout;
    for (const run of runs) {
      run.sourceValidity = consistent ? 'verified' : 'invalid';
      if (!consistent) { run.status = 'infrastructure_error'; run.failureCategory = 'source_changed'; }
    }
    await writeFile(path.join(output, 'runs.json'), JSON.stringify(runs, null, 2));
    await writeFile(path.join(output, 'source-validation.json'), JSON.stringify({ consistent, before: { checkout: identity.checkout, dirtyTreeHash: identity.dirtyTreeHash }, after: { checkout: after.checkout, dirtyTreeHash: after.dirtyTreeHash } }, null, 2));
    await writeFile(path.join(output, 'source-manifest.json'), JSON.stringify(identity, null, 2));
    await writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(summarizeTaskRuns(runs), null, 2));
    if (!consistent) throw new Error('Source changed during evaluation; records retained as infrastructure errors.');
    console.log(`Offline evaluation: ${runs.filter(run => run.status === 'passed').length}/${runs.length} passed. ${output}`);
    if (runs.some(run => run.status !== 'passed')) process.exitCode = 1;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 4) throw new Error('Usage: node scripts/run-agent-task-evals.mjs [plan.json] [output-directory]');
  await execute(path.resolve(process.argv[2] ?? path.join(repository, 'evals/agent-tasks/evaluation-plan.json')), path.resolve(process.argv[3] ?? path.join(repository, 'test-results/agent-evals', randomUUID())));
}
