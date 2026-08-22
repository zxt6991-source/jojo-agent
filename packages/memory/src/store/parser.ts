import { createHash } from 'node:crypto';
import { MemoryKindSchema, MemoryStatusSchema, type MemoryEntry, type MemoryParseWarning } from '@desktop-agent/contracts';

export type ParsedMemoryEntry = MemoryEntry & { rawStart: number; rawEnd: number; raw: string };
export type ParsedMemoryDocument = { entries: ParsedMemoryEntry[]; warnings: MemoryParseWarning[] };

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
    } catch { /* fall through */ }
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function dateMillis(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleBefore(content: string, offset: number): string | undefined {
  const prefix = content.slice(0, offset);
  const headings = [...prefix.matchAll(/^#{1,6}\s+(.+)$/gmu)];
  return headings.at(-1)?.[1]?.trim();
}

export function parseMemoryDocument(
  content: string,
  sourceFile: string,
  scopeId: string,
  updatedAt = Date.now()
): ParsedMemoryDocument {
  const entries: ParsedMemoryEntry[] = [];
  const warnings: MemoryParseWarning[] = [];
  const marker = /<!--\s*jojo-memory\s*\n([\s\S]*?)\n\s*-->/gu;
  const matches = [...content.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index ?? 0;
    const metadata: Record<string, string> = {};
    let invalidLine = false;
    for (const line of (match[1] ?? '').split('\n')) {
      if (!line.trim()) continue;
      const separator = line.indexOf(':');
      if (separator <= 0) {
        invalidLine = true;
        continue;
      }
      metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const afterComment = start + match[0].length;
    const nextMarker = matches[index + 1]?.index ?? content.length;
    const nextHeadingRelative = content.slice(afterComment, nextMarker).search(/\n#{1,6}\s+/u);
    const end = nextHeadingRelative >= 0 ? afterComment + nextHeadingRelative : nextMarker;
    const body = content.slice(afterComment, end).trim();
    const line = content.slice(0, start).split('\n').length;
    const kind = MemoryKindSchema.safeParse(metadata.kind);
    const status = MemoryStatusSchema.safeParse(metadata.status ?? 'proposed');
    if (invalidLine || !metadata.id || !kind.success || !status.success || !body) {
      warnings.push({ sourceFile, line, message: `Ignored invalid memory entry${metadata.id ? ` ${metadata.id}` : ''}.` });
      continue;
    }
    const known = new Set([
      'id', 'kind', 'status', 'title', 'tags', 'createdAt', 'updatedAt', 'sourceSessionId',
      'sourceOperationId', 'ruleMode', 'triggers'
    ]);
    const unknownMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => !known.has(key)));
    const title = metadata.title || titleBefore(content, start);
    const createdAt = dateMillis(metadata.createdAt, updatedAt);
    const entry: ParsedMemoryEntry = {
      id: metadata.id,
      scopeId,
      kind: kind.data,
      status: status.data,
      ...(title ? { title } : {}),
      content: body,
      tags: parseList(metadata.tags),
      sourceFile,
      ...(metadata.sourceSessionId ? { sourceSessionId: metadata.sourceSessionId } : {}),
      ...(metadata.sourceOperationId ? { sourceOperationId: metadata.sourceOperationId } : {}),
      createdAt,
      updatedAt: dateMillis(metadata.updatedAt, createdAt),
      contentHash: hash(body),
      ...(metadata.ruleMode === 'always' || metadata.ruleMode === 'triggered'
        ? { ruleMode: metadata.ruleMode }
        : {}),
      ...(metadata.triggers ? { triggers: parseList(metadata.triggers) } : {}),
      unknownMetadata,
      rawStart: start,
      rawEnd: end,
      raw: content.slice(start, end)
    };
    entries.push(entry);
  }
  return { entries, warnings };
}

export function serializeMemoryEntry(input: {
  id: string;
  kind: MemoryEntry['kind'];
  title: string;
  content: string;
  tags?: string[];
  status?: MemoryEntry['status'];
  sourceSessionId?: string;
  sourceOperationId?: string;
  ruleMode?: 'always' | 'triggered';
  triggers?: string[];
  createdAt?: number;
}): string {
  const createdAt = new Date(input.createdAt ?? Date.now()).toISOString();
  const lines = [
    `## ${input.title}`,
    '',
    '<!-- jojo-memory',
    `id: ${input.id}`,
    `kind: ${input.kind}`,
    `status: ${input.status ?? 'proposed'}`,
    `title: ${input.title.replace(/\r?\n/gu, ' ')}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${createdAt}`,
    ...(input.tags?.length ? [`tags: ${JSON.stringify(input.tags)}`] : []),
    ...(input.sourceSessionId ? [`sourceSessionId: ${input.sourceSessionId}`] : []),
    ...(input.sourceOperationId ? [`sourceOperationId: ${input.sourceOperationId}`] : []),
    ...(input.ruleMode ? [`ruleMode: ${input.ruleMode}`] : []),
    ...(input.triggers?.length ? [`triggers: ${JSON.stringify(input.triggers)}`] : []),
    '-->',
    input.content.trim()
  ];
  return lines.join('\n');
}
