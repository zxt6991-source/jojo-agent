import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceRevisionInputsSchema, type WorkspaceRevision, type WorkspaceRevisionInputs, type WorkspaceRevisionCapture } from '@desktop-agent/contracts';
import { resolveWorkspaceRoot, resolveWorkspacePath } from './workspace-paths.js';
const exec = promisify(execFile);
const EXCLUDES = ['.git/**', '.jojo/**', '**/node_modules/**', '**/.vite/**', '**/dist/**', '**/coverage/**'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function pattern(value: string): RegExp {
  let regex = '^';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '*' && value[index + 1] === '*') {
      index++;
      if (value[index + 1] === '/') { index++; regex += '(?:.*/)?'; }
      else regex += '.*';
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${regex}$`, 'u');
}
/** Read-only bounded evidence capture. Neither git nor project configuration authorizes execution. */
export class WorkspaceRevisionService {
  readonly capture: WorkspaceRevisionCapture = async request => {
    request.signal.throwIfAborted();
    const root = await resolveWorkspaceRoot(request.workingDirectory);
    const inputs = WorkspaceRevisionInputsSchema.parse(request.inputs ?? { mode: 'git', include: ['**/*'] });
    inputs.exclude = [...new Set([...EXCLUDES, ...inputs.exclude])].sort();
    inputs.include.sort();
    const workspaceId = digest(root);
    const scopeHash = digest(JSON.stringify(inputs));
    const unknown = (reason: string): WorkspaceRevision => ({ workspaceId, scopeHash, inputs, capturedAt: new Date().toISOString(), captureStatus: 'unknown', reason, fileCount: 0, byteCount: 0 });
    try {
      // Two complete scans also catch additions/deletions between enumeration and hashing.
      let previous = await this.scan(root, inputs, request.signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = await this.scan(root, inputs, request.signal);
        if (previous.id === next.id) return { ...next, workspaceId, scopeHash, inputs, capturedAt: new Date().toISOString(), captureStatus: 'complete' };
        previous = next;
      }
      return unknown('workspace_unstable');
    } catch (error) {
      request.signal.throwIfAborted();
      return unknown(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'revision_capture_failed');
    }
  };
  private async scan(root: string, inputs: WorkspaceRevisionInputs, signal: AbortSignal): Promise<{ id: string; fileCount: number; byteCount: number }> {
    const includes = inputs.include.map(pattern), excludes = inputs.exclude.map(pattern);
    const included = (name: string) => includes.some(regex => regex.test(name)) && !excludes.some(regex => regex.test(name));
    let names: string[];
    if (inputs.mode === 'git') {
      const result = await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root, signal, timeout: 10000, maxBuffer: 4_000_000,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, encoding: 'utf8'
      });
      // A project nested inside a Git repository must not enumerate its parent's files.
      names = result.stdout.split('\0').filter(Boolean).filter(included);
    } else {
      names = [];
      let visited = 0;
      const visit = async (directory: string, relative: string): Promise<void> => {
        signal.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++visited > inputs.maxFiles * 4) throw Object.assign(new Error(), { code: 'revision_file_limit' });
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (excludes.some(regex => regex.test(name) || regex.test(`${name}/`))) continue;
          if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
          else if (included(name)) names.push(name);
        }
      };
      await visit(root, '');
    }
    names = [...new Set(names)].sort();
    if (names.length > inputs.maxFiles) throw Object.assign(new Error(), { code: 'revision_file_limit' });
    if (!names.length) throw Object.assign(new Error(), { code: 'revision_empty_scope' });
    let byteCount = 0;
    const hash = createHash('sha256');
    for (const name of names) {
      signal.throwIfAborted();
      if (name.includes('\0') || path.isAbsolute(name) || name.split('/').includes('..')) throw Object.assign(new Error(), { code: 'revision_path_invalid' });
      const target = path.join(root, name);
      const resolved = await resolveWorkspacePath(root, name);
      if (!resolved.inside || resolved.target !== target) throw Object.assign(new Error(), { code: 'revision_path_invalid' });
      let info;
      try { info = await lstat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update(JSON.stringify([name, 'deleted'])); continue; }
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error(), { code: 'revision_unsupported_file' });
      if (byteCount + info.size > inputs.maxBytes) throw Object.assign(new Error(), { code: 'revision_byte_limit' });
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const contentHash = createHash('sha256');
      try {
        const before = await file.stat();
        if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino) throw Object.assign(new Error(), { code: 'revision_unstable_file' });
        const openedPath = await resolveWorkspacePath(root, name);
        if (!openedPath.inside || openedPath.target !== target) throw Object.assign(new Error(), { code: 'revision_path_invalid' });
        const buffer = Buffer.alloc(65536);
        let position = 0;
        while (true) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead; byteCount += bytesRead;
          if (byteCount > inputs.maxBytes) throw Object.assign(new Error(), { code: 'revision_byte_limit' });
          contentHash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        const pathInfo = await lstat(target);
        const finalPath = await resolveWorkspacePath(root, name);
        if (!finalPath.inside || finalPath.target !== target || pathInfo.dev !== after.dev || pathInfo.ino !== after.ino) throw Object.assign(new Error(), { code: 'revision_unstable_file' });
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw Object.assign(new Error(), { code: 'revision_unstable_file' });
        hash.update(JSON.stringify([name, contentHash.digest('hex'), after.mode & 0o111]));
      } finally { await file.close(); }
    }
    return { id: hash.digest('hex'), fileCount: names.length, byteCount };
  }
}
