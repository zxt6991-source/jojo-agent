import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceChangesSchema, type WorkspaceChange, type WorkspaceChanges } from '@desktop-agent/contracts';

const execFileAsync = promisify(execFile);
const MAX_FILES = 100;
const MAX_PATCH_BYTES = 250_000;

type GitStatus = { path: string; status: WorkspaceChange['status'] };

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  return result.stdout;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseStatus(output: string): GitStatus[] {
  return output.split('\0').filter(Boolean).map((entry) => {
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    let status: WorkspaceChange['status'] = 'modified';
    if (code === '??') status = 'untracked';
    else if (code.includes('D')) status = 'deleted';
    else if (code.includes('A')) status = 'added';
    return { path: filePath, status };
  });
}

function patchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function limitPatch(patch: string): { patch: string; truncated: boolean } {
  const bytes = Buffer.byteLength(patch);
  if (bytes <= MAX_PATCH_BYTES) return { patch, truncated: false };
  const buffer = Buffer.from(patch);
  return { patch: `${buffer.subarray(0, MAX_PATCH_BYTES).toString('utf8')}\n[diff truncated]`, truncated: true };
}

async function untrackedPatch(absolutePath: string, displayPath: string): Promise<{ patch: string; truncated: boolean }> {
  const content = await readFile(absolutePath);
  if (content.includes(0)) return { patch: `Binary file ${displayPath} is not shown.`, truncated: false };
  const limited = content.subarray(0, MAX_PATCH_BYTES);
  const text = limited.toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  const patch = [
    `diff --git a/${displayPath} b/${displayPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${displayPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body
  ].join('\n');
  return { patch: content.byteLength > limited.byteLength ? `${patch}\n[diff truncated]` : patch, truncated: content.byteLength > limited.byteLength };
}

export async function collectWorkspaceChanges(workingDirectory: string): Promise<WorkspaceChanges> {
  let workspaceRoot: string;
  let repositoryRoot: string;
  try {
    workspaceRoot = await realpath(workingDirectory);
    repositoryRoot = (await git(workspaceRoot, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return WorkspaceChangesSchema.parse({ isGitRepository: false, files: [], additions: 0, deletions: 0, truncated: false });
  }

  const rawStatus = await git(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', workspaceRoot]);
  const statuses = parseStatus(rawStatus);
  const limitedStatuses = statuses.slice(0, MAX_FILES);
  const files: WorkspaceChange[] = [];

  for (const item of limitedStatuses) {
    const absolutePath = path.resolve(repositoryRoot, item.path);
    if (!inside(workspaceRoot, absolutePath)) continue;
    const displayPath = path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath);
    let patchInfo: { patch: string; truncated: boolean } | undefined;
    if (item.status === 'untracked') {
      const target = await realpath(absolutePath);
      if (!inside(workspaceRoot, target)) continue;
      patchInfo = await untrackedPatch(target, displayPath);
    }
    else {
      let patch = '';
      try { patch = await git(repositoryRoot, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', item.path]); }
      catch {
        if (item.status !== 'deleted') {
          const target = await realpath(absolutePath);
          if (!inside(workspaceRoot, target)) continue;
          patchInfo = await untrackedPatch(target, displayPath);
        }
        else patchInfo = { patch: `Deleted file ${displayPath}`, truncated: false };
      }
      patchInfo ??= limitPatch(patch);
    }
    const stats = patchStats(patchInfo.patch);
    files.push({ path: displayPath, status: item.status, ...stats, patch: patchInfo.patch, truncated: patchInfo.truncated });
  }

  return WorkspaceChangesSchema.parse({
    isGitRepository: true,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: statuses.length > limitedStatuses.length || files.some((file) => file.truncated)
  });
}
