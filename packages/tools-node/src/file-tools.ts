import { withWorkspaceMutationLock } from './workspace-mutation-lock.js';
import { classifyArtifact } from '@desktop-agent/contracts';
import { produceWorkspaceArtifact } from './artifact-storage.js';
import { FileMutationJournalService } from './file-mutation-journal.js';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { prepareFileMutation } from './file-mutation.js';
import { toolResult } from './tool-result.js';

type FileToolName = 'write_file' | 'edit_file' | 'delete_file';

const definitions: Record<FileToolName, Tool['definition']> = {
  write_file: {
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file. Existing files must first be read completely. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace an exact text fragment in a UTF-8 file previously read in this turn. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean', default: false }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    }
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file previously read in this turn. A recoverable copy is saved in the application trash. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  }
};

class FileMutationTool implements Tool {
  readonly replay = 'never' as const;
  readonly definition: Tool['definition'];

  constructor(
    private readonly name: FileToolName,
    private readonly snapshots: FileSnapshotRegistry,
    private readonly trashDirectory: string
  ) {
    this.definition = definitions[name];
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    return withWorkspaceMutationLock(context.workingDirectory, () => this.executeLocked(input, context));
  }

  private async executeLocked(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return toolResult(false, 'File changes require approval.', { code: 'permission_denied' });
    const prepared = await prepareFileMutation(
      { id: '', name: this.name, input },
      context.workingDirectory,
      this.snapshots
    );

    const trashed = prepared.before !== null;
    const journalResult = await new FileMutationJournalService(this.trashDirectory, this.snapshots, true).executeApproved([prepared], context);
    if (!journalResult.ok) return journalResult;
    if (prepared.kind === 'delete') return { ...journalResult, content: `Deleted ${prepared.relativePath}.${trashed ? ' A copy was saved in the application trash.' : ''} ${journalResult.content}` };
    const action = prepared.kind === 'create' ? 'Created' : 'Updated';
    const result = { ...journalResult, content: `${action} ${prepared.relativePath}.${trashed ? ' The previous version was saved in the application trash.' : ''}` };
    result.artifacts = [];
    if (classifyArtifact(prepared.target).kind !== 'unknown') {
      try { result.artifacts = [await produceWorkspaceArtifact(context.workingDirectory, prepared.target, this.name as 'write_file' | 'edit_file')]; }
      catch { result.content += ' Artifact preview unavailable (file changed or exceeds the preview limit).'; }
    }
    return result;
  }
}

export class WriteFileTool extends FileMutationTool {
  constructor(snapshots: FileSnapshotRegistry, trashDirectory: string) {
    super('write_file', snapshots, trashDirectory);
  }
}

export class EditFileTool extends FileMutationTool {
  constructor(snapshots: FileSnapshotRegistry, trashDirectory: string) {
    super('edit_file', snapshots, trashDirectory);
  }
}

export class DeleteFileTool extends FileMutationTool {
  constructor(snapshots: FileSnapshotRegistry, trashDirectory: string) {
    super('delete_file', snapshots, trashDirectory);
  }
}
