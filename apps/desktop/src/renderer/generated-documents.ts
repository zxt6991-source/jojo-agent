import { GeneratedDocumentSchema, type GeneratedDocument } from '@desktop-agent/contracts';
import type { ConversationNode } from './conversation';

export function generatedDocuments(nodes: ConversationNode[]): (GeneratedDocument & { id: string })[] {
  return nodes.flatMap((node) => {
    if (node.kind !== 'tool' || node.state !== 'ok') return [];
    let input = node.input;
    // Recover documents from older conversations without reading arbitrary local paths.
    if (node.name === 'write_file' && input && typeof input === 'object') {
      const legacy = input as Record<string, unknown>;
      input = { name: typeof legacy.path === 'string' ? legacy.path.split(/[/\\]/).pop() : '', content: legacy.content };
    } else if (node.name !== 'create_document') return [];
    const parsed = GeneratedDocumentSchema.safeParse(input);
    return parsed.success ? [{ id: node.id, ...parsed.data }] : [];
  });
}
