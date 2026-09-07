import { z } from 'zod';
import { GeneratedDocumentSchema } from './generated-document';
import type { Message } from './messages';

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const ArtifactKindSchema = z.enum(['html', 'markdown', 'image', 'pdf', 'document', 'spreadsheet', 'presentation', 'text', 'unknown']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export const ArtifactDescriptorSchema = z.object({
  id: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).refine((name) => !/[\\/]/u.test(name) && [...name].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) && name !== '.' && name !== '..'),
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u),
  kind: ArtifactKindSchema,
  source: z.enum(['create_document', 'write_file', 'edit_file', 'show_artifact', 'generated']),
  storage: z.discriminatedUnion('type', [
    z.object({ type: z.literal('conversation'), content: z.string().min(1).max(2_000_000) }).strict(),
    z.object({ type: z.literal('workspace'), path: z.string().min(1).max(4096).refine((path) => !path.includes('\0')) }).strict()
  ]),
  size: z.number().int().nonnegative().optional(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  preview: z.object({ renderer: z.enum(['html', 'markdown', 'image', 'pdf', 'text', 'download-only']), safe: z.boolean().optional() }).optional(),
  presentation: z.object({ preferred: z.enum(['inline', 'panel', 'download']) }).optional(),
  security: z.object({ originalTrusted: z.literal(false), previewSanitized: z.boolean() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

const types: Record<string, [ArtifactKind, string]> = {
  html: ['html', 'text/html'], htm: ['html', 'text/html'],
  md: ['markdown', 'text/markdown'], markdown: ['markdown', 'text/markdown'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
  webp: ['image', 'image/webp'], gif: ['image', 'image/gif'], svg: ['image', 'image/svg+xml'],
  pdf: ['pdf', 'application/pdf'], txt: ['text', 'text/plain'], csv: ['text', 'text/csv'],
  docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
};
export function classifyArtifact(name: string): { kind: ArtifactKind; mimeType: string } {
  const [kind, mimeType] = types[name.split('.').pop()?.toLowerCase() ?? ''] ?? ['unknown', 'application/octet-stream'];
  return { kind, mimeType };
}
export function artifactRenderer(artifact: Pick<ArtifactDescriptor, 'kind' | 'mimeType'>): NonNullable<ArtifactDescriptor['preview']>['renderer'] {
  // MIME/kind mismatches never select an active renderer. Renderer hints are not trusted.
  if (artifact.kind === 'html' && artifact.mimeType === 'text/html') return 'html';
  if (artifact.kind === 'markdown' && artifact.mimeType === 'text/markdown') return 'markdown';
  if (artifact.kind === 'image' && /^image\/(png|jpeg|webp|gif|svg\+xml)$/u.test(artifact.mimeType)) return 'image';
  if (artifact.kind === 'text' && ['text/plain', 'text/csv'].includes(artifact.mimeType)) return 'text';
  return 'download-only';
}
export interface ArtifactNode {
  kind: string; id: string; name?: string; state?: string; input?: unknown; artifacts?: ArtifactDescriptor[];
}
export interface ToolArtifactExtractor {
  match(node: ArtifactNode): boolean;
  extract(node: ArtifactNode): ArtifactDescriptor[];
}
const legacyExtractor: ToolArtifactExtractor = {
  match: (node) => node.name === 'create_document' || node.name === 'write_file',
  extract(node) {
    const input = node.input as Record<string, unknown> | undefined;
    const parsed = GeneratedDocumentSchema.safeParse(node.name === 'write_file' && input
      ? { name: typeof input.path === 'string' ? input.path.split(/[/\\]/u).pop() : '', content: input.content } : input);
    return parsed.success ? [{ id: node.id, ...classifyArtifact(parsed.data.name), name: parsed.data.name,
      source: node.name as 'create_document' | 'write_file', storage: { type: 'conversation', content: parsed.data.content }, version: 1 }] : [];
  }
};
/** Pure replay: deterministic versions across reloads, latest descriptor per workspace identity. */
export function detectArtifacts(nodes: readonly ArtifactNode[], extractors: readonly ToolArtifactExtractor[] = [legacyExtractor]): ArtifactDescriptor[] {
  const latest = new Map<string, ArtifactDescriptor>();
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'tool' || node.state !== 'ok' || seen.has(node.id)) continue;
    seen.add(node.id);
    const candidates = node.artifacts !== undefined ? node.artifacts : extractors.filter((e) => e.match(node)).flatMap((e) => e.extract(node));
    for (const candidate of candidates) {
      const parsed = ArtifactDescriptorSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const artifact = parsed.data;
      const key = artifact.storage.type === 'workspace' ? artifact.storage.path : artifact.id;
      const previous = latest.get(key);
      const unchanged = previous && artifact.metadata?.revision !== undefined && previous.metadata?.revision === artifact.metadata.revision;
      latest.set(key, { ...artifact, id: previous?.id ?? artifact.id, version: previous ? previous.version + (unchanged ? 0 : 1) : artifact.version });
    }
  }
  return [...latest.values()];
}
export function artifactsFromMessages(messages: readonly Message[]): ArtifactDescriptor[] {
  const calls = new Map(messages.filter((message) => message.role === 'assistant').flatMap((message) => message.content.flatMap((block) => block.type === 'tool_call' ? [[block.call.id, block.call] as const] : [])));
  return detectArtifacts(messages.filter((message) => message.role === 'tool').flatMap((message) => message.content.flatMap((block): ArtifactNode[] => {
    if (block.type !== 'tool_result') return [];
    const call = calls.get(block.result.callId);
    return [{ kind: 'tool', id: `tool:${block.result.callId}`, name: call?.name ?? '', input: call?.input,
      state: block.result.ok ? 'ok' : 'error', ...(block.result.artifacts !== undefined ? { artifacts: block.result.artifacts } : {}) }];
  })));
}
export const ARTIFACT_DELIVERY_PROMPT = 'When creating user-facing deliverables, prefer create_document for conversation HTML. Use write_file/edit_file for workspace files; supported files are automatically surfaced as artifacts. For files produced by terminal commands, scripts, converters or builds, call show_artifact after the file is ready. Briefly introduce primary artifacts in the final response.';

/** Resolve only exact paths or unambiguous basenames, never suffix guesses. */
export function resolveArtifactReference(reference: string, artifacts: readonly ArtifactDescriptor[]): ArtifactDescriptor | undefined {
  const exact = artifacts.filter((artifact) => artifact.storage.type === 'workspace' && artifact.storage.path === reference);
  if (exact.length === 1) return exact[0];
  const names = artifacts.filter((artifact) => artifact.name === reference);
  return names.length === 1 ? names[0] : undefined;
}
