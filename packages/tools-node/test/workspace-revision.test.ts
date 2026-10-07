import { chmod, mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceRevisionInputsSchema, verificationFacts, verificationValidity, verificationBatchFacts, VerificationBatchSchema, type Message } from '@desktop-agent/contracts';
import { WorkspaceRevisionService } from '../src/index.js';
const exec = promisify(execFile);
const service = new WorkspaceRevisionService();
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'revision-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;');
  const inputs = WorkspaceRevisionInputsSchema.parse({ mode: 'paths', include: ['src/**'] });
  const capture = () => service.capture({ workingDirectory: root, inputs, signal: new AbortController().signal });
  return { root, inputs, capture };
};
describe('bounded workspace revision evidence', () => {
  it('keeps sequential checks current and invalidates an external edit, including mode changes', async () => {
    const f = await fixture(); const before = await f.capture();
    expect(before.captureStatus).toBe('complete');
    const messages: Message[] = ['lint', 'types', 'tests'].flatMap((id) => [
      { id: `${id}-call`, role: 'assistant' as const, createdAt: new Date().toISOString(), content: [{ type: 'tool_call' as const, call: { id, name: 'terminal', input: {} } }] },
      { id: `${id}-result`, role: 'tool' as const, createdAt: new Date().toISOString(), content: [{ type: 'tool_result' as const, result: { callId: id, ok: true, content: 'passed', verification: { kind: 'test' as const, scope: 'src', command: 'check', args: [], cwd: '.', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, status: 'passed' as const, changeId: id, outputRef: id, revisionBefore: before, revisionAfter: before } } }] }
    ]);
    expect(verificationFacts(messages, [await f.capture()]).every(record => record.validity === 'current' && !record.stale)).toBe(true);
    await writeFile(path.join(f.root, 'src/a.ts'), 'export const a = 2;');
    expect(verificationFacts(messages, [await f.capture()]).every(record => record.validity === 'stale')).toBe(true);
    const changed = await f.capture();
    await chmod(path.join(f.root, 'src/a.ts'), 0o755);
    expect((await f.capture()).id).not.toBe(changed.id);
  });
  it('includes tracked deletions and untracked code while excluding gitignored files and caches', async () => {
    const f = await fixture();
    await exec('git', ['init', '--quiet'], { cwd: f.root });
    await writeFile(path.join(f.root, '.gitignore'), 'ignored\n');
    await exec('git', ['add', 'src/a.ts', '.gitignore'], { cwd: f.root });
    const capture = () => service.capture({ workingDirectory: f.root, signal: new AbortController().signal });
    const first = await capture();
    await writeFile(path.join(f.root, 'ignored'), 'private');
    await mkdir(path.join(f.root, '.jojo'));
    await writeFile(path.join(f.root, '.jojo/result'), 'result metadata');
    expect((await capture()).id).toBe(first.id);
    await writeFile(path.join(f.root, 'src/untracked.ts'), 'code');
    expect((await capture()).id).not.toBe(first.id);
    const nested = await service.capture({ workingDirectory: path.join(f.root, 'src'), signal: new AbortController().signal });
    expect(nested.captureStatus).toBe('complete');
  });
  it('fails closed for non-git implicit scopes, size limits and symlink escapes', async () => {
    const f = await fixture();
    expect((await service.capture({ workingDirectory: f.root, signal: new AbortController().signal })).captureStatus).toBe('unknown');
    expect((await service.capture({ workingDirectory: f.root, inputs: { ...f.inputs, maxBytes: 1 }, signal: new AbortController().signal })).reason).toBe('revision_byte_limit');
    const outside = await fixture();
    await symlink(path.join(outside.root, 'src/a.ts'), path.join(f.root, 'src/escape.ts'));
    expect((await f.capture()).captureStatus).toBe('unknown');
    const controller = new AbortController(); controller.abort();
    await expect(service.capture({ workingDirectory: f.root, inputs: f.inputs, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('derives batch lifecycle from the durable branch without replaying unknown children', async () => {
  const f = await fixture(); const revision = await f.capture();
  const timestamp = new Date().toISOString();
  const batch = VerificationBatchSchema.parse({ id: 'batch', profileHash: 'a'.repeat(64), createdAt: timestamp, deadlineAt: new Date(Date.now() + 10000).toISOString(), profile: { version: 2, inputs: f.inputs, commands: [] }, revision });
  const messages: Message[] = [{ id: 'profile-result', role: 'tool', createdAt: timestamp, content: [{ type: 'tool_result', result: { callId: 'batch', ok: true, content: '', verificationBatch: batch } }] }];
  expect(verificationBatchFacts(messages)[0]?.status).toBe('pending');
  messages.push({ id: 'attempt', role: 'assistant', createdAt: timestamp, content: [{ type: 'tool_call', call: { id: 'execute', name: 'verification_run', input: { batchId: 'batch' } } }] });
  expect(verificationBatchFacts(messages, ['execute'])[0]?.status).toBe('running');
  expect(verificationBatchFacts(messages)[0]?.status).toBe('interrupted');
  messages.push({ id: 'settled', role: 'tool', createdAt: timestamp, content: [{ type: 'tool_result', result: { callId: 'execute', ok: false, code: 'budget_exhausted', content: '' } }] });
  expect(verificationBatchFacts(messages)[0]?.status).toBe('budget_exhausted');
});
it('does not reuse old observations when the latest capture omits or cannot read the scope', async () => {
  const f = await fixture(); const revision = await f.capture();
  const record = { kind: 'test' as const, scope: 'src', command: 'node', args: [], cwd: '.', startedAt: revision.capturedAt, finishedAt: revision.capturedAt, exitCode: 0, status: 'passed' as const, changeId: 'check', revisionBefore: revision, revisionAfter: revision };
  expect(verificationValidity(record, { ...revision, workspaceId: 'b'.repeat(64) })).toBe('stale');
  const messages: Message[] = [{ id: 'result', role: 'tool', createdAt: revision.capturedAt, content: [{ type: 'tool_result', result: { callId: 'check', ok: true, content: '', verification: record } }] }, { id: 'old', role: 'assistant', createdAt: revision.capturedAt, content: [], metadata: { verificationRevisions: [revision] } }, { id: 'latest', role: 'assistant', createdAt: revision.capturedAt, content: [], metadata: { verificationRevisions: [] } }];
  expect(verificationFacts(messages)[0]?.validity).toBe('unknown');
  await unlink(path.join(f.root, 'src/a.ts'));
  expect((await f.capture()).captureStatus).toBe('unknown');
  expect(verificationFacts(messages, [await f.capture()])[0]?.stale).toBe(true);
});
