import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolCall } from '@desktop-agent/contracts';
import { DeleteFileInput, EditFileInput, WriteFileInput } from './inputs.js';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { createUnifiedDiff } from './unified-diff.js';
import { resolveWritableWorkspacePath } from './workspace-paths.js';

export type PreparedMutation = {
  kind: 'create' | 'update' | 'delete';
  root: string;
  target: string;
  relativePath: string;
  before: string | null;
  after: string | null;
  preview: {
    kind: 'create' | 'update' | 'delete';
    path: string;
    patch: string;
    additions: number;
    deletions: number;
    truncated?: boolean;
  };
};

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function replaceText(content: string, oldText: string, newText: string, replaceAll: boolean): string {
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw codedError('The requested oldText was not found in the file.', 'edit_not_found');
  if (!replaceAll && occurrences !== 1) {
    throw codedError(`oldText matched ${occurrences} locations. Provide a unique match or set replaceAll.`, 'edit_ambiguous');
  }
  return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
}

async function readTextFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw codedError('The requested path is not a regular file.', 'not_a_file');
  if (info.size > 2_000_000) throw codedError('Files larger than 2,000,000 bytes cannot be edited.', 'file_too_large');
  const content = await readFile(file, 'utf8');
  if (content.includes('\0')) throw codedError('Binary files cannot be edited.', 'binary_file');
  return content;
}

export async function prepareFileMutation(
  call: ToolCall,
  workingDirectory: string,
  snapshots: FileSnapshotRegistry
): Promise<PreparedMutation> {
  const rawPath = call.name === 'write_file'
    ? WriteFileInput.parse(call.input).path
    : call.name === 'edit_file'
      ? EditFileInput.parse(call.input).path
      : DeleteFileInput.parse(call.input).path;
  const resolved = await resolveWritableWorkspacePath(workingDirectory, rawPath);
  if (!resolved.inside) throw codedError('File changes outside the working directory are not allowed.', 'permission_denied');

  const relativePath = path.relative(resolved.root, resolved.target) || path.basename(resolved.target);
  let before: string | null = null;
  let after: string | null = null;
  let kind: PreparedMutation['kind'];

  if (call.name === 'write_file') {
    const input = WriteFileInput.parse(call.input);
    if (resolved.exists) {
      await snapshots.assertCurrent(resolved.target, true);
      before = await readTextFile(resolved.target);
      kind = 'update';
    } else {
      kind = 'create';
    }
    after = input.content;
  } else if (call.name === 'edit_file') {
    if (!resolved.exists) throw codedError('The file does not exist.', 'not_found');
    const input = EditFileInput.parse(call.input);
    await snapshots.assertCurrent(resolved.target);
    before = await readTextFile(resolved.target);
    after = replaceText(before, input.oldText, input.newText, input.replaceAll);
    kind = 'update';
  } else {
    if (!resolved.exists) throw codedError('The file does not exist.', 'not_found');
    await snapshots.assertCurrent(resolved.target);
    before = await readTextFile(resolved.target);
    after = null;
    kind = 'delete';
  }

  if (before === after) throw codedError('The requested change would not modify the file.', 'no_changes');

  const diff = createUnifiedDiff(relativePath, before, after);
  return {
    kind,
    root: resolved.root,
    target: resolved.target,
    relativePath,
    before,
    after,
    preview: { kind, path: relativePath, ...diff }
  };
}

export function mutationErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'tool_error';
}
