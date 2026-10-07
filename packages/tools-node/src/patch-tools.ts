import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { withWorkspaceMutationLock } from './workspace-mutation-lock.js';
import { FileUndoInput, preparePatch, prepareJournalMutation, saveJournal, FileMutationJournalService } from './file-mutation-journal.js';
export { ApplyPatchInput, FileUndoInput, preparePatch, patchPreview, prepareJournalMutation, assertMutationCurrent } from './file-mutation-journal.js';

export class ApplyPatchTool implements Tool {
  readonly risk = 'write' as const;
  readonly replay = 'never' as const;
  readonly definition = { name: 'apply_patch', description: 'Apply a bounded structured multi-file patch. changes contain write, exact edit, or delete operations. Existing targets must be read first; non-unique edits are rejected. All diffs are reviewed together. Conflicts are checked before any write; host mutations serialize by canonical workspace. A durable journal supports recovery and file_undo. Partial failures are rolled back only while content hashes still match; external edits are preserved. This is recoverable filesystem mutation, not a database-atomic transaction. Requires approval.', inputSchema: { type: 'object', properties: { changes: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [ { type: 'object', properties: { operation: { const: 'write' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['operation', 'path', 'content'], additionalProperties: false }, { type: 'object', properties: { operation: { const: 'edit' }, path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['operation', 'path', 'oldText', 'newText'], additionalProperties: false }, { type: 'object', properties: { operation: { const: 'delete' }, path: { type: 'string' } }, required: ['operation', 'path'], additionalProperties: false } ] } } }, required: ['changes'], additionalProperties: false } };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly directory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Patch requires approval.' };
    return withWorkspaceMutationLock(context.workingDirectory, async () => {
      const mutations = await preparePatch(input, context.workingDirectory, this.snapshots);
      return new FileMutationJournalService(this.directory, this.snapshots).executeApproved(mutations, context);
    });
  }
}
export class FileUndoTool implements Tool {
  readonly risk = 'write' as const;
  readonly replay = 'never' as const;
  readonly definition = { name: 'file_undo', description: 'Undo/redo an applied native file mutation journal, or recover an interrupted journal. Only journals belonging to this session and workspace are accessible. Current hashes must match the expected version; later user edits cause a conflict. Requires review of the concrete reverse diff. Does not undo terminal, network or database effects.', inputSchema: { type: 'object', properties: { journalId: { type: 'string' }, action: { type: 'string', enum: ['undo', 'redo', 'recover'] } }, required: ['journalId'], additionalProperties: false } };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly directory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Journal mutation requires approval.' };
    return withWorkspaceMutationLock(context.workingDirectory, async () => {
      const prepared = await prepareJournalMutation(input, context, this.directory);
      const result = await new FileMutationJournalService(this.directory, this.snapshots).executeApproved(prepared.mutations, context, prepared.journal.id);
      if (result.ok) { prepared.journal.status = FileUndoInput.parse(input).action === 'redo' ? 'applied' : FileUndoInput.parse(input).action === 'recover' ? 'rolled_back' : 'undone'; await saveJournal(this.directory, prepared.journal); }
      return result;
    });
  }
}
