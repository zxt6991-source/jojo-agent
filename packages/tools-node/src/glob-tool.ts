import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { GlobInput } from './inputs.js';
import { collectWorkspaceFiles, globToRegExp } from './search-files.js';
import { toolResult } from './tool-result.js';
import { resolveWorkspacePath } from './workspace-paths.js';

export class GlobTool implements Tool {
  readonly replay = 'safe' as const;
  readonly definition = {
    name: 'glob',
    description: 'Find project files by a glob pattern such as **/*.ts. Searches only inside the working directory and intentionally omits dependency, VCS, build, and cache directories such as node_modules and .git.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', default: '.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = GlobInput.parse(input);
    const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.path);
    if (!resolved.inside) return toolResult(false, 'Search path is outside the working directory.', { code: 'permission_denied' });
    const matcher = globToRegExp(parsed.pattern);
    const collected = await collectWorkspaceFiles(
      resolved.root,
      resolved.target,
      parsed.maxResults + 1,
      (file) => matcher.test(path.relative(resolved.root, file).split(path.sep).join('/'))
    );
    const matches = collected.files
      .map((file) => path.relative(resolved.root, file).split(path.sep).join('/'))
      .slice(0, parsed.maxResults);
    const truncated = collected.truncated || collected.files.length > parsed.maxResults;
    const suffix = truncated ? '\n[result limit reached]' : '';
    return toolResult(true, `${matches.join('\n')}${suffix}`, { truncated });
  }
}
