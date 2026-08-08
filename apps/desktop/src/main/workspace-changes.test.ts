import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectWorkspaceChanges } from './workspace-changes';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-agent-changes-'));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('collectWorkspaceChanges', () => {
  it('returns tracked and untracked text changes with patches and totals', async () => {
    const directory = await temporaryDirectory();
    git(directory, 'init');
    git(directory, 'config', 'user.email', 'agent@example.com');
    git(directory, 'config', 'user.name', 'Desktop Agent');
    await writeFile(path.join(directory, 'tracked.txt'), 'first\nsecond\n');
    git(directory, 'add', 'tracked.txt');
    git(directory, 'commit', '-m', 'initial');

    await writeFile(path.join(directory, 'tracked.txt'), 'first\nchanged\nthird\n');
    await writeFile(path.join(directory, 'new.txt'), 'alpha\nbeta\n');

    const changes = await collectWorkspaceChanges(directory);

    expect(changes.isGitRepository).toBe(true);
    expect(new Set(changes.files.map((file) => file.path))).toEqual(new Set(['new.txt', 'tracked.txt']));
    expect(changes.files.find((file) => file.path === 'new.txt')).toMatchObject({ status: 'untracked', additions: 2, deletions: 0 });
    expect(changes.files.find((file) => file.path === 'tracked.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(changes.additions).toBe(4);
    expect(changes.deletions).toBe(1);
  });

  it('returns an empty non-repository result outside Git', async () => {
    const directory = await temporaryDirectory();
    await expect(collectWorkspaceChanges(directory)).resolves.toEqual({
      isGitRepository: false, files: [], additions: 0, deletions: 0, truncated: false
    });
  });

  it('limits results to the selected workspace directory', async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    git(directory, 'init');
    git(directory, 'config', 'user.email', 'agent@example.com');
    git(directory, 'config', 'user.name', 'Desktop Agent');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside\n');
    await writeFile(path.join(directory, 'outside.txt'), 'outside\n');
    git(directory, 'add', '.');
    git(directory, 'commit', '-m', 'initial');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await writeFile(path.join(directory, 'outside.txt'), 'outside changed\n');

    const changes = await collectWorkspaceChanges(workspace);

    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]?.path).toBe('inside.txt');
  });

});
