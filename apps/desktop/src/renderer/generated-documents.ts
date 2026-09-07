import { detectArtifacts, type GeneratedDocument } from '@desktop-agent/contracts';
import type { ConversationNode } from './conversation';
/** Compatibility adapter for integrations that still consume HTML documents. */
export function generatedDocuments(nodes: ConversationNode[]): (GeneratedDocument & { id: string })[] {
  return detectArtifacts(nodes).flatMap((artifact) => artifact.kind === 'html' && artifact.storage.type === 'conversation'
    ? [{ id: artifact.id, name: artifact.name, content: artifact.storage.content }] : []);
}
