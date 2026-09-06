import { GeneratedDocumentSchema, type Tool, type ToolResult } from '@desktop-agent/contracts';

export class CreateDocumentTool implements Tool {
  readonly replay = 'safe' as const;
  readonly definition = {
    name: 'create_document',
    description: 'Create a self-contained HTML document in the conversation. The desktop chat displays a preview and a Save button. No workspace or download file is written. Prefer this for requested HTML reports; use write_file only when the user requests a file in the workspace. Include inline CSS and no scripts or external resources.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filename ending in .html, without directories.', maxLength: 180 },
        content: { type: 'string', description: 'Complete HTML document.', minLength: 1, maxLength: 2_000_000 }
      },
      required: ['name', 'content'],
      additionalProperties: false
    }
  };

  async execute(input: unknown): Promise<ToolResult> {
    const document = GeneratedDocumentSchema.parse(input);
    return { callId: '', ok: true, content: `Document ready: ${document.name}. It is available in the conversation for preview and user-initiated saving; no file has been written to the workspace.`, };
  }
}
