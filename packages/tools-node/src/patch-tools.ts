import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { prepareFileMutation, mutationApprovalFingerprint, type PreparedMutation } from './file-mutation.js';
import { createUnifiedDiff } from './unified-diff.js';
import { resolveWritableWorkspacePath, resolveWorkspaceRoot } from './workspace-paths.js';
import { withWorkspaceMutationLock } from './workspace-mutation-lock.js';

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
async function durableWrite(filename: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, filename);
    const parent = await open(path.dirname(filename), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
function journalFilename(directory: string, sessionId: string, journalId: string): string {
  return path.join(directory, 'patch-journals', createHash('sha256').update(sessionId).digest('hex'), `${journalId}.json`);
}
async function saveJournal(directory: string, journal: Journal): Promise<void> { await durableWrite(journalFilename(directory, journal.sessionId, journal.id), JSON.stringify(journal)); }
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
  if (mutation.after === null) { await unlink(mutation.target); return; }
  await mkdir(path.dirname(mutation.target), { recursive: true });
  const temporary = `${mutation.target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode ?? 0o600);
  try { await file.writeFile(mutation.after, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try {
    await assertMutationCurrent(mutation);
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, mutation.target);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function executeBatch(mutations: RestorableMutation[], context: ToolContext, directory: string, snapshots: FileSnapshotRegistry, parentJournalId?: string): Promise<ToolResult> {
  for (const mutation of mutations) await assertMutationCurrent(mutation);
  context.signal.throwIfAborted();
  if (!mutations.length) return { callId: '', ok: true, content: 'Journal already matches the recovered state.' };
  const journal: Journal = { version: 1, id: randomUUID(), sessionId: context.sessionId, root: mutations[0]!.root, createdAt: new Date().toISOString(), status: 'prepared', attempted: 0, ...(parentJournalId ? { parentJournalId } : {}), changes: [] };
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
export class ApplyPatchTool implements Tool {
  readonly risk = 'write' as const;
  readonly replay = 'never' as const;
  readonly definition = { name: 'apply_patch', description: 'Apply a bounded structured multi-file patch. changes contain write, exact edit, or delete operations. Existing targets must be read first; non-unique edits are rejected. All diffs are reviewed together. Conflicts are checked before any write; host mutations serialize by canonical workspace. A durable journal supports recovery and file_undo. Partial failures are rolled back only while content hashes still match; external edits are preserved. This is recoverable filesystem mutation, not a database-atomic transaction. Requires approval.', inputSchema: { type: 'object', properties: { changes: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [ { type: 'object', properties: { operation: { const: 'write' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['operation', 'path', 'content'], additionalProperties: false }, { type: 'object', properties: { operation: { const: 'edit' }, path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['operation', 'path', 'oldText', 'newText'], additionalProperties: false }, { type: 'object', properties: { operation: { const: 'delete' }, path: { type: 'string' } }, required: ['operation', 'path'], additionalProperties: false } ] } } }, required: ['changes'], additionalProperties: false } };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly directory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Patch requires approval.' };
    return withWorkspaceMutationLock(context.workingDirectory, async () => {
      const mutations = await preparePatch(input, context.workingDirectory, this.snapshots);
      this.snapshots.assertMutationApproval(context.sessionId, context.toolCallId, mutationApprovalFingerprint(mutations));
      return executeBatch(mutations, context, this.directory, this.snapshots);
    });
  }
}
export class FileUndoTool implements Tool {
  readonly risk = 'write' as const;
  readonly replay = 'never' as const;
  readonly definition = { name: 'file_undo', description: 'Undo/redo an applied multi-file patch journal, or recover an interrupted journal. Only journals belonging to this session and workspace are accessible. Current hashes must match the expected version; later user edits cause a conflict. Requires review of the concrete reverse diff. Does not undo terminal, network or database effects.', inputSchema: { type: 'object', properties: { journalId: { type: 'string' }, action: { type: 'string', enum: ['undo', 'redo', 'recover'] } }, required: ['journalId'], additionalProperties: false } };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly directory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Journal mutation requires approval.' };
    return withWorkspaceMutationLock(context.workingDirectory, async () => {
      const prepared = await prepareJournalMutation(input, context, this.directory);
      this.snapshots.assertMutationApproval(context.sessionId, context.toolCallId, mutationApprovalFingerprint(prepared.mutations));
      const result = await executeBatch(prepared.mutations, context, this.directory, this.snapshots, prepared.journal.id);
      if (result.ok) { prepared.journal.status = FileUndoInput.parse(input).action === 'redo' ? 'applied' : FileUndoInput.parse(input).action === 'recover' ? 'rolled_back' : 'undone'; await saveJournal(this.directory, prepared.journal); }
      return result;
    });
  }
}
