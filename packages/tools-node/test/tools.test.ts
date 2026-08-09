import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DefaultPermissionGate,
  ListFilesTool,
  ReadFileTool,
  TerminalTool,
  createDefaultTools
} from '../src/index.js';

const context = (workingDirectory: string, options: { approved?: boolean; signal?: AbortSignal } = {}) => ({
  workingDirectory,
  approved: options.approved ?? false,
  signal: options.signal ?? new AbortController().signal,
  onProgress: () => undefined
});

describe('node tools', () => {
  it('reads and truncates a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-tools-'));
    await writeFile(path.join(root, 'large.txt'), 'abcdef');
    const result = await new ReadFileTool(3).execute({ path: 'large.txt' }, context(root));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('abc');
  });

  it('does not traverse a symlink outside the workspace when listing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await mkdir(path.join(root, 'safe'));
    await symlink(outside, path.join(root, 'escape'));
    const result = await new ListFilesTool().execute({ path: '.', depth: 3 }, context(root));
    expect(result.content).not.toContain('secret.txt');
  });

  it('lists entries in stable order and observes depth and ignore rules', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-list-'));
    await mkdir(path.join(root, 'nested'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'z.txt'), 'z');
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'nested', 'child.txt'), 'child');
    await writeFile(path.join(root, 'node_modules', 'ignored.txt'), 'ignored');

    const result = await new ListFilesTool().execute({ path: '.', depth: 0 }, context(root));

    expect(result.ok).toBe(true);
    expect(result.content.split('\n')).toEqual(['file a.txt', 'dir nested', 'file z.txt']);
  });

  it('reports when the list entry limit is reached', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-list-limit-'));
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'b.txt'), 'b');

    const result = await new ListFilesTool(1).execute({ path: '.' }, context(root));

    expect(result.truncated).toBe(true);
    expect(result.content).toBe('file a.txt\n[entry limit reached]');
  });

  it('does not report truncation when the entry count exactly matches the limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-list-exact-limit-'));
    await writeFile(path.join(root, 'only.txt'), 'only');

    const result = await new ListFilesTool(1).execute({ path: '.' }, context(root));

    expect(result.truncated).toBeUndefined();
    expect(result.content).toBe('file only.txt');
  });

  it('asks before reading outside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-gate-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-file-'));
    const file = path.join(outside, 'outside.txt');
    await writeFile(file, 'outside');
    const decision = await new DefaultPermissionGate().check(
      { id: 'c1', name: 'read_file', input: { path: file } }, { sessionId: 's1', workingDirectory: root }
    );
    expect(decision.decision).toBe('ask');
  });

  it('rejects an out-of-workspace terminal cwd before requesting approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-gate-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-gate-outside-'));

    const decision = await new DefaultPermissionGate().check(
      { id: 'c2', name: 'terminal', input: { command: process.execPath, cwd: outside } },
      { sessionId: 's1', workingDirectory: root }
    );

    expect(decision).toMatchObject({ decision: 'deny' });
  });

  it('requires approval when TerminalTool is called directly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-terminal-'));

    const result = await new TerminalTool().execute(
      { command: process.execPath, args: ['--version'] },
      context(root)
    );

    expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('captures terminal output and non-zero exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-terminal-output-'));
    const progress: string[] = [];
    const result = await new TerminalTool().execute(
      { command: process.execPath, args: ['-e', 'console.log("hello"); process.exit(2)'] },
      { ...context(root, { approved: true }), onProgress: (text) => progress.push(text) }
    );

    expect(result).toMatchObject({ ok: false, code: 'nonzero_exit' });
    expect(result.content).toContain('hello');
    expect(result.content).toContain('[exit 2]');
    expect(progress.join('')).toContain('hello');
  });

  it('distinguishes terminal cancellation from a process failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-terminal-cancel-'));
    const controller = new AbortController();
    controller.abort();

    const result = await new TerminalTool().execute(
      { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      context(root, { approved: true, signal: controller.signal })
    );

    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(result.content).toContain('[cancelled]');
  });

  it('reports terminal timeouts explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-terminal-timeout-'));

    const result = await new TerminalTool().execute(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 1_000
      },
      context(root, { approved: true })
    );

    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(result.content).toContain('[timeout]');
  });

  it('creates a fresh set of default tools', () => {
    const first = createDefaultTools();
    const second = createDefaultTools();

    expect(first.map((tool) => tool.definition.name)).toEqual(['read_file', 'list_files', 'terminal']);
    expect(first[0]).not.toBe(second[0]);
  });
});
