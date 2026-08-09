import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { ListFilesInput } from './inputs.js';
import { toolResult } from './tool-result.js';
import { isInside, resolveWorkspacePath } from './workspace-paths.js';

const DEFAULT_MAX_ENTRIES = 500;
const IGNORED_ENTRIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.next',
  '.cache'
]);

type WalkState = {
  lines: string[];
  truncated: boolean;
};

export class ListFilesTool implements Tool {
  readonly definition = {
    name: 'list_files',
    description: 'List files under a directory in the session working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        depth: { type: 'integer', minimum: 0, maximum: 5, default: 3 }
      },
      additionalProperties: false
    }
  };

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = ListFilesInput.parse(input);
    const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.path);

    if (!resolved.inside) {
      return toolResult(false, 'Directory is outside the working directory.', { code: 'permission_denied' });
    }

    const state: WalkState = { lines: [], truncated: false };
    await this.walk(resolved.root, resolved.target, 0, parsed.depth, state);

    const suffix = state.truncated ? '\n[entry limit reached]' : '';
    return toolResult(true, `${state.lines.join('\n')}${suffix}`, { truncated: state.truncated });
  }

  private async walk(
    root: string,
    directory: string,
    currentDepth: number,
    maxDepth: number,
    state: WalkState
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;

      const candidate = path.join(directory, entry.name);
      if (!await this.isSafeCandidate(root, candidate)) continue;

      if (state.lines.length >= this.maxEntries) {
        state.truncated = true;
        return;
      }

      const relative = path.relative(root, candidate) || '.';
      state.lines.push(`${entry.isDirectory() ? 'dir' : 'file'} ${relative}`);

      if (entry.isDirectory() && currentDepth < maxDepth) {
        await this.walk(root, candidate, currentDepth + 1, maxDepth, state);
        if (state.truncated) return;
      }
    }
  }

  private async isSafeCandidate(root: string, candidate: string): Promise<boolean> {
    try {
      const resolved = await realpath(candidate);
      return isInside(root, resolved);
    } catch {
      // Entries can disappear or become unreadable while a directory is being walked.
      return false;
    }
  }
}
