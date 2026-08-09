import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { GrepInput } from './inputs.js';
import { collectWorkspaceFiles, globToRegExp } from './search-files.js';
import { toolResult } from './tool-result.js';
import { resolveWorkspacePath } from './workspace-paths.js';

const MAX_FILE_BYTES = 1_000_000;

export class GrepTool implements Tool {
  readonly definition = {
    name: 'grep',
    description: 'Search text in project files and return path:line:content matches. Dependency, VCS, build, and cache directories such as node_modules and .git are intentionally omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', default: '.' },
        glob: { type: 'string' },
        caseSensitive: { type: 'boolean', default: false },
        maxResults: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }
      },
      required: ['query'],
      additionalProperties: false
    }
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = GrepInput.parse(input);
    const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.path);
    if (!resolved.inside) return toolResult(false, 'Search path is outside the working directory.', { code: 'permission_denied' });
    const matcher = parsed.glob ? globToRegExp(parsed.glob) : null;
    const collected = await collectWorkspaceFiles(resolved.root, resolved.target, 10_000);
    const query = parsed.caseSensitive ? parsed.query : parsed.query.toLocaleLowerCase();
    const matches: string[] = [];

    for (const file of collected.files) {
      if (matches.length > parsed.maxResults) break;
      const relative = path.relative(resolved.root, file).split(path.sep).join('/');
      if (matcher && !matcher.test(relative)) continue;
      let info;
      try { info = await stat(file); } catch { continue; }
      if (info.size > MAX_FILE_BYTES) continue;
      let content: string;
      try { content = await readFile(file, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const candidate = parsed.caseSensitive ? lines[index]! : lines[index]!.toLocaleLowerCase();
        if (!candidate.includes(query)) continue;
        matches.push(`${relative}:${index + 1}:${lines[index]}`);
        if (matches.length > parsed.maxResults) break;
      }
    }

    const truncated = collected.truncated || matches.length > parsed.maxResults;
    const suffix = truncated ? '\n[result limit reached]' : '';
    return toolResult(true, `${matches.slice(0, parsed.maxResults).join('\n')}${suffix}`, { truncated });
  }
}
