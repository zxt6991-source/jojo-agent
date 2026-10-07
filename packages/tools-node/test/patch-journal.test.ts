import { mkdtemp, mkdir, readFile, writeFile, realpath, chmod, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@desktop-agent/contracts';
import { ApplyPatchTool, FileUndoTool, DefaultPermissionGate, FileSnapshotRegistry } from '../src/index.js';
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'patch-journal-')));
  const journal = await mkdtemp(path.join(os.tmpdir(), 'patch-journal-store-'));
  const snapshots = new FileSnapshotRegistry();
  const context: ToolContext = { sessionId: 's', workingDirectory: root, approved: true, signal: new AbortController().signal, onProgress: () => undefined };
  await writeFile(path.join(root, 'a.txt'), 'original A'); await writeFile(path.join(root, 'b.txt'), 'original B');
  await snapshots.record(path.join(root, 'a.txt'), true); await snapshots.record(path.join(root, 'b.txt'), true);
  return { root, journal, snapshots, context, tool: new ApplyPatchTool(snapshots, journal) };
};
const patch = { changes: [{ operation: 'edit', path: 'a.txt', oldText: 'original A', newText: 'updated A' }, { operation: 'edit', path: 'b.txt', oldText: 'original B', newText: 'updated B' }] };
describe('recoverable structured patch and journal undo', () => {
  it('preflights every target and rejects conflicts before writing any file', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'b.txt'), 'user edit');
    await expect(f.tool.execute(patch, f.context)).rejects.toMatchObject({ code: 'file_conflict' });
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('original A');
    expect(await readFile(path.join(f.root, 'b.txt'), 'utf8')).toBe('user edit');
  });
  it('pins the approved diff even when another native tool advances read snapshots', async () => {
    const f = await fixture(); const gate = new DefaultPermissionGate(f.snapshots, undefined, f.journal);
    expect((await gate.check({ id: 'patch', name: 'apply_patch', input: patch }, f.context)).decision).toBe('ask');
    await writeFile(path.join(f.root, 'a.txt'), 'original A plus later edit');
    await f.snapshots.record(path.join(f.root, 'a.txt'), true);
    await expect(f.tool.execute(patch, { ...f.context, toolCallId: 'patch' })).rejects.toMatchObject({ code: 'file_conflict' });
    expect(await readFile(path.join(f.root, 'b.txt'), 'utf8')).toBe('original B');
  });
  it('undoes and redoes a persisted journal, rejects another session, and preserves later user edits', async () => {
    const f = await fixture();
    const result = await f.tool.execute(patch, f.context);
    expect(result.ok).toBe(true);
    const journalId = (result.structuredResult as { journalId: string }).journalId;
    const undo = new FileUndoTool(new FileSnapshotRegistry(), f.journal);
    await expect(undo.execute({ journalId }, { ...f.context, sessionId: 'private' })).rejects.toThrow();
    expect((await undo.execute({ journalId }, f.context)).ok).toBe(true);
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('original A');
    expect((await undo.execute({ journalId, action: 'redo' }, f.context)).ok).toBe(true);
    await writeFile(path.join(f.root, 'a.txt'), 'later user edit');
    await expect(undo.execute({ journalId }, f.context)).rejects.toMatchObject({ code: 'file_conflict' });
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('later user edit');
    expect(await readFile(path.join(f.root, 'b.txt'), 'utf8')).toBe('updated B');
  });
  it('rolls back a partial cancellation while preserving unrelated external edits', async () => {
    const f = await fixture(); const controller = new AbortController();
    const result = await f.tool.execute(patch, { ...f.context, signal: controller.signal, onProgress: () => controller.abort() });
    expect(result).toMatchObject({ ok: false, code: 'cancelled', structuredResult: { status: 'rolled_back' } });
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('original A');
    expect(await readFile(path.join(f.root, 'b.txt'), 'utf8')).toBe('original B');
  });
  it('restores deleted executable permissions and reconciles an interrupted journal after restart', async () => {
    const f = await fixture();
    await chmod(path.join(f.root, 'a.txt'), 0o755);
    const result = await f.tool.execute({ changes: [{ operation: 'delete', path: 'a.txt' }] }, f.context);
    const journalId = (result.structuredResult as { journalId: string }).journalId;
    const filename = path.join(f.journal, 'patch-journals', createHash('sha256').update('s').digest('hex'), `${journalId}.json`);
    // Persist the state a killed process would leave after a write but before commit.
    const journal = JSON.parse(await readFile(filename, 'utf8'));
    journal.status = 'applying';
    await writeFile(filename, JSON.stringify(journal));
    const restarted = new FileUndoTool(new FileSnapshotRegistry(), f.journal);
    expect((await restarted.execute({ journalId, action: 'recover' }, f.context)).ok).toBe(true);
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('original A');
    expect((await stat(path.join(f.root, 'a.txt'))).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await readFile(filename, 'utf8')).status).toBe('rolled_back');
  });
  it('preserves a conflicting external edit during recovery and allows retry after reconciliation', async () => {
    const f = await fixture(); const controller = new AbortController();
    const result = await f.tool.execute(patch, { ...f.context, signal: controller.signal, onProgress: () => {
      // This synchronous external mutation occurs between native operations.
      controller.abort();
    } });
    const journalId = (result.structuredResult as { journalId: string }).journalId;
    const directory = path.join(f.journal, 'patch-journals', createHash('sha256').update('s').digest('hex'));
    expect(await readdir(directory)).toContain(`${journalId}.json`);
    const filename = path.join(directory, `${journalId}.json`);
    const journal = JSON.parse(await readFile(filename, 'utf8'));
    journal.status = 'needs_recovery';
    await writeFile(filename, JSON.stringify(journal));
    await writeFile(path.join(f.root, 'a.txt'), 'external edit');
    const undo = new FileUndoTool(f.snapshots, f.journal);
    await expect(undo.execute({ journalId, action: 'recover' }, f.context)).rejects.toMatchObject({ code: 'file_conflict' });
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('external edit');
    await writeFile(path.join(f.root, 'a.txt'), 'original A');
    expect((await undo.execute({ journalId, action: 'recover' }, f.context)).ok).toBe(true);
  });
  it('rejects duplicate, binary and escaping targets', async () => {
    const f = await fixture();
    await expect(f.tool.execute({ changes: [patch.changes[0], patch.changes[0]] }, f.context)).rejects.toMatchObject({ code: 'patch_duplicate_path' });
    await expect(f.tool.execute({ changes: [{ operation: 'write', path: '../escape', content: 'bad' }] }, f.context)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(f.tool.execute({ changes: [{ operation: 'write', path: 'binary', content: '\0' }] }, f.context)).rejects.toThrow();
    await mkdir(path.join(f.root, 'directory'));
    await expect(f.tool.execute({ changes: [{ operation: 'write', path: 'directory', content: 'bad' }] }, f.context)).rejects.toThrow();
  });
});
