import type { MemoryEntry, MemorySearchHit, MemorySearchResult, MemoryScope } from '@desktop-agent/contracts';

const RRF_K = 60;

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function snippet(content: string, query: string): string {
  const offset = normalized(content).indexOf(normalized(query));
  const start = Math.max(0, offset < 0 ? 0 : offset - 80);
  const end = Math.min(content.length, start + 320);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

export function fuseMemoryResults(input: {
  query: string;
  fts: MemorySearchResult[];
  semantic: Array<{ entry: MemoryEntry; similarity: number }>;
  scopes: MemoryScope[];
  limit: number;
}): MemorySearchHit[] {
  const fused = new Map<string, {
    entry: MemoryEntry;
    ftsRank?: number;
    semanticRank?: number;
    similarity?: number;
    score: number;
  }>();
  input.fts.forEach((result, index) => fused.set(result.entry.id, {
    entry: result.entry, ftsRank: index + 1, score: 1 / (RRF_K + index + 1)
  }));
  input.semantic.forEach((result, index) => {
    const current = fused.get(result.entry.id);
    if (current) {
      current.semanticRank = index + 1;
      current.similarity = result.similarity;
      current.score += 1 / (RRF_K + index + 1);
    } else {
      fused.set(result.entry.id, {
        entry: result.entry,
        semanticRank: index + 1,
        similarity: result.similarity,
        score: 1 / (RRF_K + index + 1)
      });
    }
  });
  const scopeKinds = new Map(input.scopes.map((scope) => [scope.id, scope.kind]));
  const query = normalized(input.query);
  for (const value of fused.values()) {
    const exact = normalized(`${value.entry.title ?? ''}\n${value.entry.content}\n${value.entry.tags.join(' ')}`).includes(query);
    if (exact && value.ftsRank !== undefined) value.score += 0.1;
    if (scopeKinds.get(value.entry.scopeId) === 'project') value.score *= 1.05;
    if (value.entry.status === 'confirmed') value.score *= 1.02;
  }
  return [...fused.values()].sort((left, right) => right.score - left.score)
    .slice(0, input.limit).map((value) => {
      const scope = scopeKinds.get(value.entry.scopeId) ?? 'global';
      const modes: Array<'fts' | 'semantic'> = [];
      if (value.ftsRank !== undefined) modes.push('fts');
      if (value.semanticRank !== undefined) modes.push('semantic');
      return {
        id: value.entry.id,
        scope,
        kind: value.entry.kind,
        ...(value.entry.title ? { title: value.entry.title } : {}),
        snippet: snippet(value.entry.content, input.query),
        sourceFile: value.entry.sourceFile,
        ...(value.entry.title ? { heading: value.entry.title } : {}),
        updatedAt: new Date(value.entry.updatedAt).toISOString(),
        retrieval: {
          ...(value.ftsRank !== undefined ? { ftsRank: value.ftsRank } : {}),
          ...(value.semanticRank !== undefined ? { semanticRank: value.semanticRank } : {}),
          ...(value.similarity !== undefined ? { semanticSimilarity: value.similarity } : {}),
          fusedScore: value.score,
          modes
        }
      };
    });
}
