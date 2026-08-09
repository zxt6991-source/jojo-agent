import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DefaultPermissionGate,
  DeleteFileTool,
  EditFileTool,
  FileSnapshotRegistry,
  GlobTool,
  GrepTool,
  ReadFileTool,
  WriteFileTool
} from '../src/index.js';

const context = (workingDirectory: string, approved = false) => ({
  sessionId: 'session-1',
  workingDirectory,
  approved,
  signal: new AbortController().signal,
  onProgress: () => undefined
});

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-files-'));
  const trash = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-trash-'));
  const snapshots = new FileSnapshotRegistry();
  return {
    root,
    trash,
    snapshots,
    gate: new DefaultPermissionGate(snapshots),
    read: new ReadFileTool(undefined, snapshots),
    write: new WriteFileTool(snapshots, trash),
    edit: new EditFileTool(snapshots, trash),
    remove: new DeleteFileTool(snapshots, trash)
  };
}

describe('file mutation tools', () => {
  it('requires a read, previews an exact edit, writes it, and backs up the original', async () => {
    const tools = await runtime();
    const file = path.join(tools.root, 'example.ts');
    await writeFile(file, 'export const value = 1;\n');
    const call = {
      id: 'edit-1',
      name: 'edit_file',
      input: { path: 'example.ts', oldText: 'value = 1', newText: 'value = 2' }
    };

    await expect(tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'deny', code: 'read_required' });
    await tools.read.execute({ path: 'example.ts' }, context(tools.root));
    const decision = await tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root });
    expect(decision).toMatchObject({
      decision: 'ask',
      request: { preview: { kind: 'update', path: 'example.ts', additions: 1, deletions: 1 } }
    });
    if (decision.decision !== 'ask') throw new Error('Expected approval request.');
    expect(decision.request.preview?.patch).toContain('-export const value = 1;');
    expect(decision.request.preview?.patch).toContain('+export const value = 2;');

    await expect(tools.edit.execute(call.input, context(tools.root, true))).resolves.toMatchObject({ ok: true });
    await expect(readFile(file, 'utf8')).resolves.toBe('export const value = 2;\n');
    const [entry] = await readdir(path.join(tools.trash, 'session-1'));
    await expect(readFile(path.join(tools.trash, 'session-1', entry!, 'files', 'example.ts'), 'utf8'))
      .resolves.toBe('export const value = 1;\n');
  });

  it('refuses to write when a file changes after preview approval', async () => {
    const tools = await runtime();
    const file = path.join(tools.root, 'conflict.txt');
    await writeFile(file, 'before\n');
    await tools.read.execute({ path: 'conflict.txt' }, context(tools.root));
    const call = { id: 'edit-2', name: 'edit_file', input: { path: 'conflict.txt', oldText: 'before', newText: 'agent' } };
    await expect(tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'ask' });

    await writeFile(file, 'external change\n');
    await expect(tools.edit.execute(call.input, context(tools.root, true))).rejects.toMatchObject({ code: 'file_conflict' });
    await expect(readFile(file, 'utf8')).resolves.toBe('external change\n');
  });

  it('creates new files with approval and deletes read files into trash', async () => {
    const tools = await runtime();
    const createCall = { id: 'write-1', name: 'write_file', input: { path: 'new.txt', content: 'created\n' } };
    await expect(tools.gate.check(createCall, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'ask', request: { preview: { kind: 'create' } } });
    await tools.write.execute(createCall.input, context(tools.root, true));
    await expect(readFile(path.join(tools.root, 'new.txt'), 'utf8')).resolves.toBe('created\n');

    await tools.read.execute({ path: 'new.txt' }, context(tools.root));
    const deleteCall = { id: 'delete-1', name: 'delete_file', input: { path: 'new.txt' } };
    await expect(tools.gate.check(deleteCall, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'ask', request: { preview: { kind: 'delete' } } });
    await tools.remove.execute(deleteCall.input, context(tools.root, true));
    await expect(stat(path.join(tools.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates missing parent directories inside the workspace', async () => {
    const tools = await runtime();
    const input = { path: 'src/generated/example.ts', content: 'export {};\n' };

    await expect(tools.gate.check(
      { id: 'write-nested', name: 'write_file', input },
      { sessionId: 'session-1', workingDirectory: tools.root }
    )).resolves.toMatchObject({ decision: 'ask' });
    await tools.write.execute(input, context(tools.root, true));

    await expect(readFile(path.join(tools.root, 'src/generated/example.ts'), 'utf8'))
      .resolves.toBe('export {};\n');
  });

  it('rejects writes through a symlink that escapes the workspace', async () => {
    const tools = await runtime();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(tools.root, 'escape'));
    const call = { id: 'write-2', name: 'write_file', input: { path: 'escape/secret.txt', content: 'changed' } };

    await expect(tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'deny', code: 'permission_denied' });
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });

  it('requires a complete read before replacing an existing file', async () => {
    const tools = await runtime();
    await writeFile(path.join(tools.root, 'large.txt'), 'abcdef');
    const partialReader = new ReadFileTool(3, tools.snapshots);
    await partialReader.execute({ path: 'large.txt' }, context(tools.root));
    const call = { id: 'write-3', name: 'write_file', input: { path: 'large.txt', content: 'replacement' } };

    await expect(tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'deny', code: 'read_required' });
  });

  it('preserves file permissions when replacing a file', async () => {
    const tools = await runtime();
    const file = path.join(tools.root, 'script.sh');
    await writeFile(file, '#!/bin/sh\necho old\n', { mode: 0o755 });
    await tools.read.execute({ path: 'script.sh' }, context(tools.root));

    await tools.write.execute(
      { path: 'script.sh', content: '#!/bin/sh\necho new\n' },
      context(tools.root, true)
    );

    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('rejects ambiguous exact edits unless replaceAll is explicit', async () => {
    const tools = await runtime();
    await writeFile(path.join(tools.root, 'repeat.txt'), 'same same\n');
    await tools.read.execute({ path: 'repeat.txt' }, context(tools.root));
    const call = { id: 'edit-3', name: 'edit_file', input: { path: 'repeat.txt', oldText: 'same', newText: 'new' } };

    await expect(tools.gate.check(call, { sessionId: 'session-1', workingDirectory: tools.root }))
      .resolves.toMatchObject({ decision: 'deny', code: 'edit_ambiguous' });
    await expect(tools.gate.check(
      { ...call, input: { ...call.input, replaceAll: true } },
      { sessionId: 'session-1', workingDirectory: tools.root }
    )).resolves.toMatchObject({ decision: 'ask' });
  });
});

describe('project search tools', () => {
  it('finds files by glob and text by grep while honoring filters', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-search-'));
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'const Needle = 1;\n');
    await writeFile(path.join(root, 'src', 'b.js'), 'const needle = 2;\n');
    await writeFile(path.join(root, 'node_modules', 'hidden.ts'), 'Needle');

    const glob = await new GlobTool().execute({ pattern: '**/*.ts' }, context(root));
    expect(glob.content).toContain('src/a.ts');
    expect(glob.content).not.toContain('hidden.ts');

    const grep = await new GrepTool().execute({ query: 'needle', glob: '**/*.ts' }, context(root));
    expect(grep.content).toBe('src/a.ts:1:const Needle = 1;');
  });

  it('marks search output truncated only when additional results exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-search-limit-'));
    await writeFile(path.join(root, 'one.ts'), 'hit\n');
    const glob = new GlobTool();
    const grep = new GrepTool();

    expect((await glob.execute({ pattern: '*.ts', maxResults: 1 }, context(root))).truncated).toBeUndefined();
    expect((await grep.execute({ query: 'hit', maxResults: 1 }, context(root))).truncated).toBeUndefined();

    await writeFile(path.join(root, 'two.ts'), 'hit\n');
    await expect(glob.execute({ pattern: '*.ts', maxResults: 1 }, context(root)))
      .resolves.toMatchObject({ truncated: true });
    await expect(grep.execute({ query: 'hit', maxResults: 1 }, context(root)))
      .resolves.toMatchObject({ truncated: true });
  });
});
