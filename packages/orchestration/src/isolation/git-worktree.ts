import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IsolationSnapshot } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import { canonicalizeExisting, isInside } from './paths.js';

const execFileAsync = promisify(execFile);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_BYTES = 250_000;
const MAX_DIFF_STAT_CHARACTERS = 16_000;

export type GitRepository = {
  repoRoot: string;
  sourceRoot: string;
  relativeWorkspace: string;
  headCommit: string;
};

export type WorktreeInspection = Pick<
  IsolationSnapshot,
  'changedFiles' | 'diffStat' | 'diff' | 'hasChanges' | 'truncated'
>;

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) return stderr.split('\n').find((line) => line.trim()) ?? stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
}

function parsePorcelain(output: string): Array<{ code: string; path: string }> {
  return output.split('\0').filter(Boolean).flatMap((entry) => {
    const filePath = entry.slice(3);
    return filePath ? [{ code: entry.slice(0, 2), path: filePath }] : [];
  });
}

function limitText(value: string, maxBytes: number, marker: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return { text: value, truncated: false };
  return { text: `${Buffer.from(value).subarray(0, maxBytes).toString('utf8').trimEnd()}\n${marker}`, truncated: true };
}

async function untrackedPatch(absolutePath: string, displayPath: string): Promise<string> {
  try {
    const content = await readFile(absolutePath);
    if (content.includes(0)) return `Binary file ${displayPath} is not shown.\n`;
    const limited = content.subarray(0, MAX_DIFF_BYTES);
    const text = limited.toString('utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const body = lines.map((line) => `+${line}`).join('\n');
    const patch = [
      `diff --git a/${displayPath} b/${displayPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${displayPath}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      body
    ].join('\n');
    return content.byteLength > limited.byteLength ? `${patch}\n[diff truncated]\n` : `${patch}\n`;
  } catch {
    return `Unable to read untracked file ${displayPath}\n`;
  }
}

export async function resolveGitRepository(workingDirectory: string): Promise<GitRepository> {
  let sourceRoot: string;
  try {
    sourceRoot = await canonicalizeExisting(workingDirectory);
  } catch {
    throw new OrchestrationError('worktree_path_invalid', `Working directory does not exist: ${workingDirectory}`);
  }
  let toplevel: string;
  try {
    toplevel = (await git(sourceRoot, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    throw new OrchestrationError(
      'worktree_not_a_git_repository',
      `Writable agents require a Git repository so worktree isolation can be created. ${gitErrorMessage(error)}`
    );
  }
  const repoRoot = await canonicalizeExisting(toplevel);
  if (!isInside(repoRoot, sourceRoot)) {
    throw new OrchestrationError('worktree_path_invalid', 'Working directory is outside the Git repository.');
  }
  let headCommit: string;
  try {
    headCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  } catch (error) {
    throw new OrchestrationError(
      'worktree_create_failed',
      `Unable to resolve repository HEAD. ${gitErrorMessage(error)}`
    );
  }
  return {
    repoRoot,
    sourceRoot,
    relativeWorkspace: path.relative(repoRoot, sourceRoot),
    headCommit
  };
}

export async function addGitWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  headCommit: string;
}): Promise<void> {
  await mkdir(path.dirname(input.worktreePath), { recursive: true });
  try {
    await git(input.repoRoot, [
      'worktree', 'add',
      '-b', input.branch,
      input.worktreePath,
      input.headCommit
    ]);
  } catch (error) {
    await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
    throw new OrchestrationError(
      'worktree_create_failed',
      `Failed to create git worktree: ${gitErrorMessage(error)}`
    );
  }
}

export async function inspectGitWorktree(worktreePath: string): Promise<WorktreeInspection> {
  const entries = parsePorcelain(await git(worktreePath, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'
  ]));
  const changedFiles = entries.slice(0, MAX_CHANGED_FILES).map((entry) => entry.path);
  const untrackedFiles = entries.filter((entry) => entry.code === '??').map((entry) => entry.path).slice(0, MAX_CHANGED_FILES);

  let diff = '';
  try { diff = await git(worktreePath, ['diff', '--no-ext-diff', '--unified=3', 'HEAD']); }
  catch { diff = ''; }

  for (const file of untrackedFiles) {
    diff += await untrackedPatch(path.resolve(worktreePath, file), file);
  }

  let diffStat = '';
  try { diffStat = (await git(worktreePath, ['diff', '--stat', 'HEAD'])).trim(); }
  catch { diffStat = ''; }
  if (untrackedFiles.length > 0) {
    const extra = untrackedFiles.map((file) => ` ${file} | untracked`).join('\n');
    diffStat = [diffStat, extra].filter(Boolean).join('\n');
  }

  const limitedDiff = limitText(diff, MAX_DIFF_BYTES, '[diff truncated]');
  const limitedStat = limitText(diffStat, MAX_DIFF_STAT_CHARACTERS, '[diffstat truncated]');
  return {
    changedFiles,
    ...(limitedStat.text ? { diffStat: limitedStat.text } : {}),
    ...(limitedDiff.text ? { diff: limitedDiff.text } : {}),
    hasChanges: entries.length > 0,
    truncated: entries.length > changedFiles.length || limitedDiff.truncated || limitedStat.truncated
  };
}

export async function removeGitWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    try {
      await git(repoRoot, ['worktree', 'prune']);
    } catch (pruneError) {
      throw new OrchestrationError(
        'worktree_cleanup_failed',
        `Failed to remove git worktree: ${gitErrorMessage(error)}; ${gitErrorMessage(pruneError)}`
      );
    }
  }
}

export async function deleteGitBranch(repoRoot: string, branch: string): Promise<void> {
  if (!branch.startsWith('jojo/')) {
    throw new OrchestrationError('worktree_path_invalid', 'Refusing to delete a branch that was not created by isolation.');
  }
  try {
    await git(repoRoot, ['branch', '-D', branch]);
  } catch (error) {
    throw new OrchestrationError(
      'worktree_cleanup_failed',
      `Failed to delete temporary branch ${branch}: ${gitErrorMessage(error)}`
    );
  }
}

export async function repositoryIndexFingerprint(repoRoot: string): Promise<string> {
  const [head, status] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  ]);
  return `${head.trim()}\n${status}`;
}
