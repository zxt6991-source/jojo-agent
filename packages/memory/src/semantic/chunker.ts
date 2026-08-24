import { createHash } from 'node:crypto';
import type { MemoryChunk, MemoryEntry, MemoryScope } from '@desktop-agent/contracts';

export const MEMORY_CHUNKING_VERSION = 1;
export const MEMORY_NORMALIZATION_VERSION = 1;
const MAX_CHUNK_CHARACTERS = 3_200;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function segments(content: string, keepWhole: boolean): string[] {
  if (content.length <= MAX_CHUNK_CHARACTERS) return [content];
  if (keepWhole) return [content.slice(0, MAX_CHUNK_CHARACTERS)];
  const paragraphs = content.split(/\n\s*\n/gu);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARACTERS) {
      if (current) chunks.push(current);
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARACTERS) {
        chunks.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARACTERS));
      }
      current = '';
    } else if (!current || current.length + paragraph.length + 2 <= MAX_CHUNK_CHARACTERS) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function memoryChunks(scope: MemoryScope, entries: MemoryEntry[], settings: {
  indexDaily: boolean;
  indexScratchpad: boolean;
}): MemoryChunk[] {
  return entries.flatMap((entry) => {
    if (entry.sourceFile.startsWith('daily/') && !settings.indexDaily) return [];
    if (entry.sourceFile === 'SCRATCHPAD.md' && !settings.indexScratchpad) return [];
    if (entry.kind === 'rule' && entry.status !== 'confirmed') return [];
    return segments(entry.content, entry.kind === 'rule').map((content, ordinal) => {
      const headingPath = entry.title ? [entry.title] : [];
      const semanticText = [
        entry.title ? `Title: ${entry.title}` : '',
        `Kind: ${entry.kind}`,
        `Scope: ${scope.kind}`,
        headingPath.length ? `Heading: ${headingPath.join(' / ')}` : '',
        `Content:\n${content}`
      ].filter(Boolean).join('\n');
      return {
        id: `memchunk_${hash(`${entry.id}\0${entry.sourceFile}\0${ordinal}`)}`,
        entryId: entry.id,
        scopeId: entry.scopeId,
        file: entry.sourceFile,
        headingPath,
        kind: entry.kind,
        status: entry.status,
        ...(entry.title ? { title: entry.title } : {}),
        content: semanticText,
        contentHash: hash(semanticText),
        updatedAt: entry.updatedAt
      };
    });
  });
}
