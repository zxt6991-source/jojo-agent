import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultPermissionGate, ListFilesTool, ReadFileTool } from '../src/index.js';

const context = (workingDirectory: string) => ({
  workingDirectory, approved: false, signal: new AbortController().signal, onProgress: () => undefined
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
});
