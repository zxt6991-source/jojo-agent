import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { verificationFacts, WorkspaceRevisionInputsSchema } from '@desktop-agent/contracts';
import { EditFileTool } from '../../packages/tools-node/src/file-tools.js';
import { WorkspaceRevisionService } from '../../packages/tools-node/src/workspace-revision.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { ModelProvider } from '@desktop-agent/contracts';
import { runSkillCompactionFixture } from './skill-compaction-fixture.js';
import { executeScenario } from './fixture-runtime.js';
import { FileSnapshotRegistry } from '../../packages/tools-node/src/file-snapshots.js';
import { ReadFileTool } from '../../packages/tools-node/src/read-file-tool.js';
import { ApplyPatchTool } from '../../packages/tools-node/src/patch-tools.js';
import { DefaultPermissionGate } from '../../packages/tools-node/src/default-permission-gate.js';
import { z } from 'zod';
import { TerminalTool } from '../../packages/tools-node/src/terminal-tool.js';
import { ResultReadTool } from '../../packages/tools-node/src/result-read-tool.js';
import { VerificationProfileTool } from '../../packages/tools-node/src/verification-profile-tool.js';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import { createSessionHistoryTools } from '../../packages/tools-node/src/session-history-tools.js';
import type { SessionSearchHit, SessionReadWindow } from '@desktop-agent/contracts';
import { VerificationRunTool } from '../../packages/tools-node/src/verification-run-tool.js';

const Fixture = z.object({
  version: z.literal(1), files: z.object({ 'a.txt': z.string(), 'b.txt': z.string() }).strict(),
  externalEdit: z.object({ path: z.literal('b.txt'), content: z.string() }).strict(),
  changes: z.array(z.object({ operation: z.literal('edit'), path: z.enum(['a.txt', 'b.txt']), oldText: z.string(), newText: z.string() }).strict()).length(2)
}).strict();

/** Offline fixture drives real governance and native tools; scores are filesystem/ledger checks. */
export async function runPatchConflictFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) {
  const fixture = Fixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  for (const [name, content] of Object.entries(fixture.files)) await writeFile(path.join(root, name), content);
  const snapshots = new FileSnapshotRegistry();
  const scripted = new ScriptedProvider([
    [
      { type: 'tool_call_completed', call: { id: 'read-a', name: 'read_file', input: { path: 'a.txt' } } },
      { type: 'tool_call_completed', call: { id: 'read-b', name: 'read_file', input: { path: 'b.txt' } } },
      { type: 'response_completed', stopReason: 'tool_calls' }
    ],
    [{ type: 'tool_call_completed', call: { id: 'patch', name: 'apply_patch', input: { changes: fixture.changes } } }, { type: 'response_completed', stopReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'The patch conflicted; preserve the user edit.' }, { type: 'response_completed', stopReason: 'stop' }]
  ]);
  let approvals = 0;
  return executeScenario({ root, taskId: 'patch-conflict', timeoutMs, provider: scripted,
    tools: [new ReadFileTool(undefined, snapshots), new ApplyPatchTool(snapshots, storeDirectory)],
    permissions: new DefaultPermissionGate(snapshots, undefined, storeDirectory),
    approval: { requestApproval: async request => {
      if (request.call.name !== 'apply_patch') return false;
      approvals++;
      await writeFile(path.join(root, fixture.externalEdit.path), fixture.externalEdit.content);
      return true;
    } },
    verify: async (_result, results) => {
      const patch = results.find(item => item.callId === 'patch');
      const a = await readFile(path.join(root, 'a.txt'), 'utf8');
      const b = await readFile(path.join(root, 'b.txt'), 'utf8');
      return { criteria: [
        { id: 'conflict-rejected', passed: approvals === 1 && patch?.ok === false && patch.code === 'file_conflict', evidence: 'trace.json#toolResults/patch' },
        { id: 'user-edit-preserved', passed: b === fixture.externalEdit.content, evidence: 'trace.json#files/b.txt' },
        { id: 'no-partial-write', passed: a === fixture.files['a.txt'], evidence: 'trace.json#files/a.txt' }
      ], evidence: { files: { 'a.txt': a, 'b.txt': b }, approvals } };
    }
  });
}

const MiddleFixture = z.object({ version: z.literal(1), padding: z.number().int().min(15000).max(100000), marker: z.string().regex(/^MIDDLE_ERROR: [a-z ]{1,100}$/u), offset: z.number().int().min(0), limit: z.number().int().min(1).max(12000) }).strict();
export async function runMiddleFailureFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) {
  const fixture = MiddleFixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  const terminal = new TerminalTool();
  const code = `process.stdout.write('x'.repeat(${fixture.padding})+${JSON.stringify(fixture.marker)}+'y'.repeat(${fixture.padding}));process.exitCode=1;`;
  const input = { command: process.execPath, args: ['-e', code], timeoutMs: 10000 };
  let reclaimed = false;
  let markerInProjection = false;
  let approvals = 0;
  const provider: ModelProvider = { async *stream(request) {
    const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    const source = results.find(result => result.callId === 'long');
    const window = results.find(result => result.callId === 'window');
    if (!source) yield { type: 'tool_call_completed', call: { id: 'long', name: 'terminal', input } };
    else if (!window) {
      reclaimed = source.content.includes('characters reclaimed');
      markerInProjection = source.content.includes(fixture.marker);
      yield { type: 'tool_call_completed', call: { id: 'window', name: 'result_read', input: { callId: 'long', offset: fixture.offset, limit: fixture.limit } } };
    } else {
      yield { type: 'text_delta', text: window.content.match(/MIDDLE_ERROR: [a-z ]+/u)?.[0].split('y')[0] ?? 'No original failure evidence found.' };
      yield { type: 'response_completed', stopReason: 'stop' }; return;
    }
    yield { type: 'response_completed', stopReason: 'tool_calls' };
  } };
  return executeScenario({ root, taskId: 'middle-failure', timeoutMs, provider, tools: [terminal, new ResultReadTool()], permissions: new DefaultPermissionGate(new FileSnapshotRegistry(), undefined, storeDirectory),
    approval: { requestApproval: async request => { if (request.call.name !== 'terminal') return false; approvals++; return true; } },
    verify: async (result, results) => {
      const original = results.find(item => item.callId === 'long');
      const window = results.find(item => item.callId === 'window');
      const source = window?.structuredResult as { sourceCallId?: string; offset?: number } | undefined;
      return { criteria: [
        { id: 'source-result-window', passed: approvals === 1 && reclaimed && !markerInProjection && source?.sourceCallId === 'long' && source.offset === fixture.offset && window?.content === original?.content.slice(fixture.offset, fixture.offset + fixture.limit), evidence: 'trace.json#toolResults/window' },
        { id: 'middle-error-found', passed: original?.ok === false && original.code === 'nonzero_exit' && window?.ok === true && window.content.includes(fixture.marker) && (result.finalText ?? '').includes(fixture.marker), evidence: 'trace.json#finalText' }
      ], evidence: { projection: { reclaimed, markerInProjection }, approvals } };
    }
  });
}

const CancelFixture = z.object({ version: z.literal(1), readyMarker: z.literal('CHECK_READY'), delayedEffectMs: z.number().int().min(5000).max(60000) }).strict();
export async function runVerificationCancelFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) {
  const fixture = CancelFixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  await mkdir(path.join(root, '.jojo'), { recursive: true });
  await writeFile(path.join(root, 'source.txt'), 'isolated cancellation input');
  await writeFile(path.join(root, '.jojo/verification.json'), JSON.stringify({ version: 2, inputs: { include: ['source.txt'] }, budgetMs: 30000,
    commands: [
      { id: 'slow', kind: 'test', scope: 'source', command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${fixture.readyMarker}\n`)});setTimeout(()=>require('node:fs').writeFileSync('late-effect.txt','unexpected'),${fixture.delayedEffectMs});`] },
      { id: 'later', kind: 'test', scope: 'source', command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('later-check.txt','unexpected')"] }
    ] }));
  const controller = new AbortController();
  let readyObserved = false;
  let approvals = 0;
  return executeScenario({ root, taskId: 'verification-cancel', timeoutMs, signal: controller.signal, provider: profileProvider(),
    tools: [new VerificationProfileTool(), new VerificationRunTool(), new TerminalTool()], permissions: new DefaultPermissionGate(new FileSnapshotRegistry(), undefined, storeDirectory),
    approval: { requestApproval: async request => { if (request.call.name !== 'terminal') return false; approvals++; return true; } },
    observe: ({ event }) => { if (event.type === 'tool.progress' && event.text.includes(fixture.readyMarker)) { readyObserved = true; controller.abort('Controlled user cancellation'); } },
    verify: async (result, results) => {
      const checks = results.filter(item => item.verification);
      const effects = { late: await exists(path.join(root, 'late-effect.txt')), later: await exists(path.join(root, 'later-check.txt')) };
      return { expectedStatus: 'cancelled', criteria: [
        { id: 'cancelled-record', passed: readyObserved && approvals === 1 && result.status === 'cancelled' && checks.some(item => item.code === 'cancelled' && item.verification?.status === 'cancelled'), evidence: 'trace.json#toolResults' },
        { id: 'no-false-pass', passed: checks.length > 0 && checks.every(item => item.verification?.status !== 'passed') && !effects.late && !effects.later, evidence: 'trace.json#effects' }
      ], evidence: { readyObserved, approvals, effects } };
    }
  });
}
function profileProvider(): ModelProvider {
  return { async *stream(request) {
    const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    const batch = results.find(result => result.verificationBatch)?.verificationBatch;
    if (!batch) yield { type: 'tool_call_completed', call: { id: 'profile', name: 'verification_profile', input: {} } };
    else if (!results.some(result => result.callId === 'batch-run')) yield { type: 'tool_call_completed', call: { id: 'batch-run', name: 'verification_run', input: { batchId: batch.id } } };
    else { yield { type: 'text_delta', text: 'Verification settled; report the recorded status.' }; yield { type: 'response_completed', stopReason: 'stop' }; return; }
    yield { type: 'response_completed', stopReason: 'tool_calls' };
  } };
}
async function exists(filename: string) { try { await access(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export const offlineFixtures = { 'patch-conflict': runPatchConflictFixture, 'middle-failure': runMiddleFailureFixture, 'verification-cancel': runVerificationCancelFixture, 'decision-recall': runDecisionRecallFixture, 'scheduler-noise': runSchedulerNoiseFixture, 'ts-repair': runTypeScriptRepairFixture, 'skill-compaction': runSkillCompactionFixture };

const HistoryFixture = z.object({ version: z.literal(1), query: z.string().min(1).max(100), decision: z.string().min(1).max(500), timestamp: z.string().datetime(), noiseCount: z.number().int().min(0).max(200) }).strict();
export async function runDecisionRecallFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) { return runHistoryFixture('decision-recall', root, storeDirectory, fixtureFile, timeoutMs); }
export async function runSchedulerNoiseFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) { return runHistoryFixture('scheduler-noise', root, storeDirectory, fixtureFile, timeoutMs); }
async function runHistoryFixture(taskId: 'decision-recall' | 'scheduler-noise', root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number) {
  const fixture = HistoryFixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  const store = new SqliteAgentRuntimeStore(path.join(storeDirectory, 'history.sqlite'));
  const originalSession = 'original-discussion';
  const privateSession = 'private-discussion';
  const originalEntry = 'decision-original';
  const provider: ModelProvider = { async *stream(request) {
    const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    const search = results.find(item => item.callId === 'search');
    const first = (search?.structuredResult as { hits?: SessionSearchHit[] } | undefined)?.hits?.[0];
    const window = results.find(item => item.callId === 'window');
    if (!search) yield { type: 'tool_call_completed', call: { id: 'search', name: 'session_search', input: { query: fixture.query, source: taskId === 'scheduler-noise' ? 'all' : 'main' } } };
    else if (!window && first) yield { type: 'tool_call_completed', call: { id: 'window', name: 'session_read_window', input: { sessionId: first.sessionId, anchorSeq: first.seq } } };
    else if (!results.some(item => item.callId === 'private-probe')) yield { type: 'tool_call_completed', call: { id: 'private-probe', name: 'session_read_window', input: { sessionId: privateSession, anchorSeq: 1 } } };
    else {
      const source = (window?.structuredResult as SessionReadWindow | undefined)?.items[0];
      yield { type: 'text_delta', text: source ? `${source.entryId} ${source.createdAt}: ${source.content}` : 'Original source unavailable.' };
      yield { type: 'response_completed', stopReason: 'stop' }; return;
    }
    yield { type: 'response_completed', stopReason: 'tool_calls' };
  } };
  try {
    return await executeScenario({ root, taskId, timeoutMs, provider, store, tools: createSessionHistoryTools(), permissions: new DefaultPermissionGate(),
      beforeRun: async runtime => {
        const append = async (sessionId: string, id: string, text: string, parentId: string | null = null) => {
          await store.appendEntry({ id, sessionId, parentId, type: 'message', message: { id, role: 'user', createdAt: fixture.timestamp, content: [{ type: 'text', text }] } });
          await store.saveLane({ sessionId, name: 'main', leafId: id, currentOperationId: null });
        };
        await runtime.openSession({ id: originalSession, executionScope: { kind: 'workspace', workingDirectory: root }, metadata: { source: 'main' } });
        await append(originalSession, originalEntry, fixture.decision);
        await runtime.openSession({ id: privateSession, executionScope: { kind: 'workspace', workingDirectory: path.join(root, 'private-project') }, metadata: { source: 'main' } });
        await append(privateSession, 'private-source', `${fixture.query} PRIVATE_SENTINEL`);
        if (fixture.noiseCount) {
          await runtime.openSession({ id: 'scheduled-digests', executionScope: { kind: 'workspace', workingDirectory: root }, metadata: { source: 'scheduler' } });
          for (let index = 0; index < fixture.noiseCount; index++) await append('scheduled-digests', `digest-${index}`, `${fixture.query} 自动日报 ${index}`, index ? `digest-${index - 1}` : null);
        }
      },
      verify: async (result, results) => {
        const hits = (results.find(item => item.callId === 'search')?.structuredResult as { hits?: SessionSearchHit[] } | undefined)?.hits ?? [];
        const window = (results.find(item => item.callId === 'window')?.structuredResult as SessionReadWindow | undefined)?.items ?? [];
        const source = window.find(item => item.entryId === originalEntry);
        const privateProbe = results.find(item => item.callId === 'private-probe');
        const sourcePassed = source?.sessionId === originalSession && source.content === fixture.decision && (result.finalText ?? '').includes(originalEntry);
        const privatePassed = privateProbe?.ok === false && privateProbe.code === 'permission_denied' && !JSON.stringify({ hits, window, finalText: result.finalText }).includes('PRIVATE_SENTINEL');
        const criteria = [
          { id: 'source-entry', passed: sourcePassed, evidence: 'trace.json#toolResults/window' },
          ...(taskId === 'scheduler-noise' ? [{ id: 'main-session-ranked', passed: hits[0]?.entryId === originalEntry && hits[0].source === 'main' && hits.some(item => item.source === 'scheduler'), evidence: 'trace.json#toolResults/search' }]
            : [{ id: 'source-time', passed: source?.createdAt === fixture.timestamp && (result.finalText ?? '').includes(fixture.timestamp), evidence: 'trace.json#finalText' }, { id: 'no-private-session-leak', passed: privatePassed, evidence: 'trace.json#toolResults/private-probe' }])
        ];
        // Even scheduler-noise must preserve scope, although its original catalog omits this criterion.
        if (taskId === 'scheduler-noise') criteria.push({ id: 'no-private-session-leak', passed: privatePassed, evidence: 'trace.json#toolResults/private-probe' });
        return { criteria, evidence: { fixture: { noiseCount: fixture.noiseCount, originalEntry, timestamp: fixture.timestamp } } };
      }
    });
  } finally { store.close(); }
}

const RepairFixture = z.object({ version: z.literal(1), before: z.string().min(1).max(1000), after: z.string().min(1).max(1000) }).strict();
export async function runTypeScriptRepairFixture(root: string, storeDirectory: string, fixtureFile: string, timeoutMs: number, compilerPath: string) {
  const fixture = RepairFixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  if (!path.isAbsolute(compilerPath)) throw new Error('Offline repair requires the installed compiler resolved by the Host.');
  const compilerDirectory = path.dirname(path.dirname(compilerPath));
  const compilerPackage = JSON.parse(await readFile(path.join(compilerDirectory, 'package.json'), 'utf8'));
  if (compilerPackage.name !== 'typescript') throw new Error('Resolved compiler is not the installed TypeScript package.');
  const copiedCompilerDirectory = path.join(root, '.fixture-deps/typescript');
  await cp(compilerDirectory, copiedCompilerDirectory, { recursive: true });
  const localCompiler = '.fixture-deps/typescript/lib/' + path.basename(compilerPath);
  await mkdir(path.join(root, '.jojo'), { recursive: true });
  await writeFile(path.join(root, 'source.ts'), fixture.before);
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, files: ['source.ts'] }));
  const inputs = WorkspaceRevisionInputsSchema.parse({ include: ['source.ts', 'tsconfig.json', '.fixture-deps/typescript/**'] });
  await writeFile(path.join(root, '.jojo/verification.json'), JSON.stringify({ version: 2, inputs, budgetMs: 30000,
    commands: [{ id: 'typecheck', kind: 'typecheck', scope: 'fixture', command: process.execPath, args: [localCompiler, '-p', 'tsconfig.json'] }] }));
  const snapshots = new FileSnapshotRegistry();
  let approvals = 0;
  const provider: ModelProvider = { async *stream(request) {
    const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    const result = (id: string) => results.find(item => item.callId === id);
    if (!result('before-profile')) yield { type: 'tool_call_completed', call: { id: 'before-profile', name: 'verification_profile', input: {} } };
    else if (!result('before-check')) yield { type: 'tool_call_completed', call: { id: 'before-check', name: 'verification_run', input: { batchId: result('before-profile')?.verificationBatch?.id } } };
    else if (!result('read')) yield { type: 'tool_call_completed', call: { id: 'read', name: 'read_file', input: { path: 'source.ts' } } };
    else if (!result('edit')) yield { type: 'tool_call_completed', call: { id: 'edit', name: 'edit_file', input: { path: 'source.ts', oldText: fixture.before, newText: fixture.after } } };
    else if (!result('after-profile')) yield { type: 'tool_call_completed', call: { id: 'after-profile', name: 'verification_profile', input: {} } };
    else if (!result('after-check')) yield { type: 'tool_call_completed', call: { id: 'after-check', name: 'verification_run', input: { batchId: result('after-profile')?.verificationBatch?.id } } };
    else {
      yield { type: 'text_delta', text: result('after-check')?.ok ? 'Final compiler check passed.' : 'Final compiler check failed.' };
      yield { type: 'response_completed', stopReason: 'stop' }; return;
    }
    yield { type: 'response_completed', stopReason: 'tool_calls' };
  } };
  return executeScenario({ root, taskId: 'ts-repair', timeoutMs, provider,
    tools: [new ReadFileTool(undefined, snapshots), new EditFileTool(snapshots, storeDirectory), new VerificationProfileTool(), new VerificationRunTool(), new TerminalTool()],
    permissions: new DefaultPermissionGate(snapshots, undefined, storeDirectory), approval: { requestApproval: async request => { if (!['terminal', 'edit_file'].includes(request.call.name)) return false; approvals++; return true; } },
    verify: async (_result, results, messages) => {
      const content = await readFile(path.join(root, 'source.ts'), 'utf8');
      const current = await new WorkspaceRevisionService().capture({ workingDirectory: root, inputs, signal: new AbortController().signal });
      const facts = verificationFacts(messages, [current]);
      const beforeBatch = results.find(item => item.callId === 'before-profile')?.verificationBatch?.id;
      const afterBatch = results.find(item => item.callId === 'after-profile')?.verificationBatch?.id;
      const before = results.find(item => item.verification?.batchId === beforeBatch && item.verification?.status === 'failed');
      const after = results.find(item => item.verification?.batchId === afterBatch && item.verification?.status === 'passed');
      const entryHash = createHash('sha256').update(await readFile(path.join(root, localCompiler))).digest('hex');
      return { criteria: [
        { id: 'expected-files', passed: content === fixture.after && results.find(item => item.callId === 'edit')?.ok === true, evidence: 'trace.json#files/source.ts' },
        { id: 'final-checks-current', passed: Boolean(after && facts.some(item => item.outputRef === after.callId && item.validity === 'current' && item.status === 'passed')), evidence: 'trace.json#verificationFacts' },
        { id: 'no-false-pass', passed: approvals === 3 && before?.ok === false && before.content.includes('TS2322') && before.verification?.exitCode !== 0 && after?.ok === true && after.verification?.exitCode === 0, evidence: 'trace.json#toolResults' }
      ], evidence: { files: { 'source.ts': content }, verificationFacts: facts, approvals, compiler: { entryHash, filename: localCompiler, version: compilerPackage.version } } };
    }
  });
}
