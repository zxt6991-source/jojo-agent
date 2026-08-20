import { chmod, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { backupFileToTrash } from './file-trash.js';
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
    if (!context.approved) return toolResult(false, 'File changes require approval.', { code: 'permission_denied' });
    const prepared = await prepareFileMutation(
      { id: '', name: this.name, input },
      context.workingDirectory,
      this.snapshots
    );

    let trashed = false;
    let previousMode: number | undefined;
    if (prepared.before !== null) {
      previousMode = (await stat(prepared.target)).mode & 0o777;
      await backupFileToTrash({
        trashDirectory: this.trashDirectory,
        sessionId: context.sessionId,
        root: prepared.root,
        target: prepared.target,
        operation: prepared.kind === 'delete' ? 'delete' : 'overwrite'
      });
      trashed = true;
    }

    if (prepared.kind === 'delete') {
      await unlink(prepared.target);
      return toolResult(true, `Deleted ${prepared.relativePath}.${trashed ? ' A copy was saved in the application trash.' : ''}`);
    }

    await mkdir(path.dirname(prepared.target), { recursive: true });
    const temporary = path.join(
      path.dirname(prepared.target),
      `.${path.basename(prepared.target)}.desktop-agent-${crypto.randomUUID()}.tmp`
    );
    try {
      await writeFile(temporary, prepared.after!, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (previousMode !== undefined) await chmod(temporary, previousMode);
      await rename(temporary, prepared.target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await this.snapshots.record(prepared.target, true);
    const action = prepared.kind === 'create' ? 'Created' : 'Updated';
    return toolResult(true, `${action} ${prepared.relativePath}.${trashed ? ' The previous version was saved in the application trash.' : ''}`);
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
