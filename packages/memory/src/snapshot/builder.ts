import { createHash } from 'node:crypto';
import type { MemoryEntry, MemoryScope, MemorySnapshot } from '@desktop-agent/contracts';
import { estimateTokens, snapshotTokenBudget, truncateToTokens } from './budget.js';

type ScopeEntries = { scope: MemoryScope; version: number; entries: MemoryEntry[] };

function renderEntry(entry: MemoryEntry): string {
  const label = entry.title ? `${entry.title}: ` : '';
  return `- [${entry.kind}] ${label}${entry.content}`;
}

export function buildMemorySnapshot(input: {
  scopes: ScopeEntries[];
  contextWindowTokens: number;
  maxTokens?: number;
  maxContextRatio?: number;
}): MemorySnapshot {
  const budget = snapshotTokenBudget(input.contextWindowTokens, input.maxTokens, input.maxContextRatio);
  const project = input.scopes.find((item) => item.scope.kind === 'project');
  const global = input.scopes.find((item) => item.scope.kind === 'global');
  const confirmedRules = (scope: ScopeEntries | undefined) => scope?.entries.filter((entry) =>
    entry.kind === 'rule' && entry.status === 'confirmed' && entry.ruleMode === 'always'
  ) ?? [];
  const regular = (scope: ScopeEntries | undefined, sourceFile?: string) => scope?.entries.filter((entry) =>
    !(entry.kind === 'rule' && entry.ruleMode === 'always') && (!sourceFile || entry.sourceFile === sourceFile)
  ) ?? [];
  const sections: Array<{ title: string; entries: MemoryEntry[]; softLimit: number }> = [
    { title: 'Confirmed project rules', entries: confirmedRules(project), softLimit: 768 },
    { title: 'Confirmed global rules', entries: confirmedRules(global), softLimit: 512 },
    { title: 'Project scratchpad', entries: regular(project, 'SCRATCHPAD.md'), softLimit: 512 },
    { title: 'Project memory', entries: regular(project, 'MEMORY.md'), softLimit: 1024 },
    { title: 'Global memory', entries: regular(global, 'MEMORY.md'), softLimit: 768 }
  ];
  let remaining = budget;
  const rendered: string[] = [];
  const sourceEntryIds: string[] = [];
  for (const section of sections) {
    if (!section.entries.length || remaining <= 0) continue;
    const sectionBudget = Math.min(section.softLimit, remaining);
    const body = truncateToTokens(section.entries.map(renderEntry).join('\n'), sectionBudget);
    if (!body) continue;
    rendered.push(`### ${section.title}\n${body}`);
    sourceEntryIds.push(...section.entries.map((entry) => entry.id));
    remaining -= estimateTokens(body);
  }
  const content = rendered.join('\n\n');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const scopeVersions = Object.fromEntries(input.scopes.map((item) => [item.scope.id, item.version]));
  return {
    id: `snap_${crypto.randomUUID().replace(/-/gu, '')}`,
    version: Math.max(0, ...Object.values(scopeVersions)),
    scope: {
      globalScopeId: 'global',
      ...(project ? { projectScopeId: project.scope.id } : {})
    },
    content,
    sourceEntryIds: [...new Set(sourceEntryIds)],
    scopeVersions,
    estimatedTokens: estimateTokens(content),
    contentHash
  };
}
