import { open, type FileHandle } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { ReadFileInput } from './inputs.js';
import { toolResult } from './tool-result.js';
import { resolveWorkspacePath } from './workspace-paths.js';

const DEFAULT_MAX_BYTES = 512_000;

export class ReadFileTool implements Tool {
  readonly definition = {
    name: 'read_file',
    description: 'Read a UTF-8 text file. Paths are relative to the session working directory unless absolute.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  };

  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path } = ReadFileInput.parse(input);
    const resolved = await resolveWorkspacePath(context.workingDirectory, path);

    if (!resolved.inside && !context.approved) {
      return toolResult(false, 'Path is outside the working directory.', { code: 'permission_denied' });
    }

    const file = await open(resolved.target, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        return toolResult(false, 'The requested path is not a file.', { code: 'not_a_file' });
      }

      const bytes = await this.readPrefix(file);
      const truncated = bytes.byteLength > this.maxBytes;
      const content = bytes.subarray(0, this.maxBytes).toString('utf8');
      return truncated
        ? toolResult(true, `${content}\n\n[truncated at ${this.maxBytes} bytes]`, { truncated: true })
        : toolResult(true, content);
    } finally {
      await file.close();
    }
  }

  private async readPrefix(file: FileHandle): Promise<Buffer> {
    const buffer = Buffer.alloc(this.maxBytes + 1);
    let offset = 0;

    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    return buffer.subarray(0, offset);
  }
}
