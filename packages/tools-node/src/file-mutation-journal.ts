import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolResult } from '@desktop-agent/contracts';
import { backupFileToTrash } from './file-trash.js';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { prepareFileMutation, mutationApprovalFingerprint, type PreparedMutation } from './file-mutation.js';
import { createUnifiedDiff } from './unified-diff.js';
import { resolveWritableWorkspacePath, resolveWorkspaceRoot } from './workspace-paths.js';

const FilePath = z.string().min(1).max(4096).refine(value => !/[\0\r\n]/u.test(value));
const Text = z.string().max(2000000).refine(value => !value.includes('\0'));
export const ApplyPatchInput = z.object({ changes: z.array(z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('write'), path: FilePath, content: Text }).strict(),
  z.object({ operation: z.literal('edit'), path: FilePath, oldText: Text.refine(value => value.length > 0), newText: Text, replaceAll: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('delete'), path: FilePath }).strict()
])).min(1).max(20) }).strict();
export const FileUndoInput = z.object({ journalId: z.string().uuid(), action: z.enum(['undo', 'redo', 'recover']).default('undo') }).strict();
const JournalSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), sessionId: z.string(), root: z.string(), createdAt: z.string(),
  status: z.enum(['prepared', 'applying', 'applied', 'rolled_back', 'needs_recovery', 'undone']),
  runId: z.string().max(256).optional(), operationId: z.string().max(256).optional(), actor: z.object({ kind: z.string().min(1).max(64), id: z.string().max(256).optional(), profile: z.string().max(256).optional() }).strict().optional(),
  attempted: z.number().int().min(0).max(20), toolCallId: z.string().optional(), parentJournalId: z.string().uuid().optional(),
  changes: z.array(z.object({ path: FilePath, before: Text.nullable(), after: Text.nullable(), beforeHash: z.string().nullable(), afterHash: z.string().nullable(), mode: z.number().int().optional() }).strict()).min(1).max(20)
}).strict();
type Journal = z.infer<typeof JournalSchema>;
type RestorableMutation = PreparedMutation & { restoreMode?: number };
const hash = (content: string | null): string | null => content === null ? null : createHash('sha256').update(content).digest('hex');
function failure(message: string, code = 'file_conflict'): never { throw Object.assign(new Error(message), { code }); }

export async function preparePatch(input: unknown, workingDirectory: string, snapshots: FileSnapshotRegistry): Promise<PreparedMutation[]> {
  const parsed = ApplyPatchInput.parse(input);
  const mutations: PreparedMutation[] = [];
  const targets = new Set<string>();
  let bytes = 0;
  for (const change of parsed.changes) {
    const name = change.operation === 'write' ? 'write_file' : change.operation === 'edit' ? 'edit_file' : 'delete_file';
    const mutation = await prepareFileMutation({ id: '', name, input: change }, workingDirectory, snapshots);
    const canonical = mutation.target.toLowerCase();
    if (targets.has(canonical)) failure('Patch targets the same canonical path more than once.', 'patch_duplicate_path');
    targets.add(canonical);
    bytes += Buffer.byteLength(mutation.before ?? '') + Buffer.byteLength(mutation.after ?? '');
    if (bytes > 8000000) failure('Combined patch contents exceed 8,000,000 bytes.', 'patch_too_large');
    mutations.push(mutation);
  }
  return mutations;
}
export function patchPreview(mutations: readonly PreparedMutation[]): PreparedMutation['preview'] {
  const patch = mutations.map(mutation => mutation.preview.patch).join('\n');
  return { kind: 'update', path: `${mutations.length} files`, patch: patch.slice(0, 500000), additions: mutations.reduce((sum, mutation) => sum + mutation.preview.additions, 0), deletions: mutations.reduce((sum, mutation) => sum + mutation.preview.deletions, 0), ...(patch.length > 500000 || mutations.some(mutation => mutation.preview.truncated) ? { truncated: true } : {}) };
}
async function currentContent(root: string, relativePath: string): Promise<{ content: string | null; target: string }> {
  const resolved = await resolveWritableWorkspacePath(root, relativePath);
  if (!resolved.inside) failure('Mutation target escaped the workspace.', 'permission_denied');
  if (!resolved.exists) return { content: null, target: resolved.target };
  const info = await stat(resolved.target);
  if (!info.isFile() || info.size > 2000000) failure('Mutation target is not a bounded text file.', 'file_too_large');
  const content = await readFile(resolved.target, 'utf8');
  if (content.includes('\0') || Buffer.byteLength(content) > 2000000) failure('Mutation target is not a bounded text file.', 'binary_file');
  const checked = await resolveWritableWorkspacePath(root, relativePath);
  if (!checked.inside || checked.target !== resolved.target) failure('Mutation target changed during reading.');
  return { content, target: resolved.target };
}
export async function assertMutationCurrent(mutation: PreparedMutation): Promise<void> {
  const current = await currentContent(mutation.root, mutation.relativePath);
  if (current.target !== mutation.target || hash(current.content) !== hash(mutation.before)) failure(`File changed before mutation: ${mutation.relativePath}`);
}
async function syncParent(filename: string): Promise<void> {
  const parent = await open(path.dirname(filename), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
async function durableWrite(filename: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, filename);
    await syncParent(filename);
  }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
function journalFilename(directory: string, sessionId: string, journalId: string): string {
  return path.join(directory, 'patch-journals', createHash('sha256').update(sessionId).digest('hex'), `${journalId}.json`);
}
export async function saveJournal(directory: string, journal: Journal): Promise<void> { await durableWrite(journalFilename(directory, journal.sessionId, journal.id), JSON.stringify(journal)); }
async function readJournal(directory: string, context: { sessionId: string; workingDirectory: string }, journalId: string): Promise<Journal> {
  const filename = journalFilename(directory, context.sessionId, z.string().uuid().parse(journalId));
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 17000000) failure('Invalid journal size.', 'journal_invalid');
    text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > 17000000) failure('Invalid journal size.', 'journal_invalid');
  } finally { await file.close(); }
  const journal = JournalSchema.parse(JSON.parse(text));
  if (journal.sessionId !== context.sessionId || journal.id !== journalId || journal.root !== await resolveWorkspaceRoot(context.workingDirectory)) failure('Journal belongs to another session or workspace.', 'permission_denied');
  for (const change of journal.changes) if (hash(change.before) !== change.beforeHash || hash(change.after) !== change.afterHash) failure('Journal content hash mismatch.', 'journal_invalid');
  return journal;
}
function journalMutation(root: string, relativePath: string, target: string, before: string | null, after: string | null): PreparedMutation {
  const kind = after === null ? 'delete' : before === null ? 'create' : 'update';
  return { root, target, relativePath, before, after, kind, preview: { kind, path: relativePath, ...createUnifiedDiff(relativePath, before, after) } };
}
export async function prepareJournalMutation(input: unknown, context: { sessionId: string; workingDirectory: string }, directory: string): Promise<{ journal: Journal; mutations: RestorableMutation[] }> {
  const parsed = FileUndoInput.parse(input);
  const journal = await readJournal(directory, context, parsed.journalId);
  if (parsed.action === 'undo' && journal.status !== 'applied') failure('Only an applied journal can be undone.', 'journal_state');
  if (parsed.action === 'redo' && journal.status !== 'undone') failure('Only an undone journal can be redone.', 'journal_state');
  if (parsed.action === 'recover' && !['prepared', 'applying', 'needs_recovery'].includes(journal.status)) failure('Journal does not require recovery.', 'journal_state');
  const changes = parsed.action === 'recover' ? journal.changes.slice(0, journal.attempted) : journal.changes;
  const mutations: RestorableMutation[] = [];
  for (const change of changes) {
    const current = await currentContent(journal.root, change.path);
    const expected = parsed.action === 'redo' ? change.before : change.after;
    const after = parsed.action === 'redo' ? change.after : change.before;
    if (parsed.action === 'recover' && hash(current.content) === hash(after)) continue;
    if (hash(current.content) !== hash(expected)) failure(`User or external edits conflict with ${parsed.action}: ${change.path}`);
    if (current.content !== after) mutations.push({ ...journalMutation(journal.root, change.path, current.target, current.content, after), ...(change.mode !== undefined ? { restoreMode: change.mode } : {}) });
  }
  return { journal, mutations };
}
async function writeMutation(mutation: PreparedMutation, mode?: number): Promise<void> {
  await assertMutationCurrent(mutation);
  if (mutation.after === null) { await unlink(mutation.target); await syncParent(mutation.target); return; }
  await mkdir(path.dirname(mutation.target), { recursive: true });
  const temporary = `${mutation.target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode ?? 0o600);
  try { await file.writeFile(mutation.after, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try {
    await assertMutationCurrent(mutation);
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, mutation.target);
    await syncParent(mutation.target);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function executeBatch(mutations: RestorableMutation[], context: ToolContext, directory: string, snapshots: FileSnapshotRegistry, parentJournalId?: string, preserveLegacyTrash = false): Promise<ToolResult> {
  for (const mutation of mutations) await assertMutationCurrent(mutation);
  context.signal.throwIfAborted();
  if (!mutations.length) return { callId: '', ok: true, content: 'Journal already matches the recovered state.' };
  if (preserveLegacyTrash) for (const mutation of mutations) if (mutation.before !== null) {
    await backupFileToTrash({ trashDirectory: directory, sessionId: context.sessionId, root: mutation.root, target: mutation.target, operation: mutation.kind === 'delete' ? 'delete' : 'overwrite' });
  }
  context.signal.throwIfAborted();
  const journal: Journal = { version: 1, id: randomUUID(), sessionId: context.sessionId, root: mutations[0]!.root, createdAt: new Date().toISOString(), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.mutationProvenance ?? {}), status: 'prepared', attempted: 0, ...(parentJournalId ? { parentJournalId } : {}), changes: [] };
  for (const mutation of mutations) journal.changes.push({ path: mutation.relativePath, before: mutation.before, after: mutation.after, beforeHash: hash(mutation.before), afterHash: hash(mutation.after), ...(mutation.before !== null ? { mode: (await stat(mutation.target)).mode & 0o777 } : {}) });
  await saveJournal(directory, journal);
  try {
    for (const [index, mutation] of mutations.entries()) {
      context.signal.throwIfAborted();
      journal.status = 'applying'; journal.attempted = index + 1;
      await saveJournal(directory, journal);
      await writeMutation(mutation, mutation.restoreMode ?? journal.changes[index]!.mode);
      context.onProgress(`Applied ${mutation.relativePath}\n`);
    }
    journal.status = 'applied'; await saveJournal(directory, journal);
    for (const mutation of mutations) if (mutation.after !== null) await snapshots.record(mutation.target, true);
    return { callId: '', ok: true, content: `Applied ${mutations.length} file changes. Journal: ${journal.id}.`, structuredResult: { journalId: journal.id, status: journal.status, paths: mutations.map(mutation => mutation.relativePath) } };
  } catch (error) {
    const conflicts: string[] = [];
    for (const change of journal.changes.slice(0, journal.attempted).reverse()) {
      try {
        const current = await currentContent(journal.root, change.path);
        if (hash(current.content) === change.beforeHash) continue;
        if (hash(current.content) !== change.afterHash) { conflicts.push(change.path); continue; }
        await writeMutation(journalMutation(journal.root, change.path, current.target, current.content, change.before), change.mode);
      } catch { conflicts.push(change.path); }
    }
    journal.status = conflicts.length ? 'needs_recovery' : 'rolled_back'; await saveJournal(directory, journal);
    return { callId: '', ok: false, code: context.signal.aborted ? 'cancelled' : conflicts.length ? 'patch_partial_failure' : 'patch_rolled_back', content: `Patch failed: ${error instanceof Error ? error.message : String(error)}. Journal ${journal.id}: ${journal.status}.${conflicts.length ? ` Conflicts preserved: ${conflicts.join(', ')}` : ''}`, structuredResult: { journalId: journal.id, status: journal.status, conflicts } };
  }
}

/** One journal implementation shared by all native file mutation tools.
 * Callers hold the workspace lock across preparation, approval validation and application.
 */
export class FileMutationJournalService {
  constructor(private readonly directory: string, private readonly snapshots: FileSnapshotRegistry, private readonly preserveLegacyTrash = false) {}
  async executeApproved(mutations: RestorableMutation[], context: ToolContext, parentJournalId?: string): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'File changes require approval.' };
    this.snapshots.assertMutationApproval(context.sessionId, context.toolCallId, mutationApprovalFingerprint(mutations));
    return executeBatch(mutations, context, this.directory, this.snapshots, parentJournalId, this.preserveLegacyTrash);
  }
}
