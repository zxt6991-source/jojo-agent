import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { produceWorkspaceArtifact } from './artifact-storage.js';
export const ShowArtifactInput = z.object({ path: z.string().min(1).max(4096), title: z.string().min(1).max(255).optional() }).strict();
export class ShowArtifactTool implements Tool {
  readonly risk = 'read' as const;
  readonly replay = 'safe' as const;
  readonly definition = {
    name: 'show_artifact',
    description: 'Deliver an existing file produced by a script, build or terminal command. Path must be a regular file in the current workspace, at most 20 MiB. Files from write_file/edit_file are already surfaced automatically.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' } }, required: ['path'], additionalProperties: false }
  };
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = ShowArtifactInput.parse(input);
    const artifact = await produceWorkspaceArtifact(context.workingDirectory, parsed.path, 'show_artifact', parsed.title);
    return { callId: '', ok: true, content: `Artifact ready: ${artifact.name}`, artifacts: [artifact] };
  }
}
