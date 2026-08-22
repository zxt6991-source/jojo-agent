import type { MemoryEntry, MemoryRecall } from '@desktop-agent/contracts';
import { estimateTokens } from '../snapshot/budget.js';

function matches(rule: MemoryEntry, text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  return (rule.triggers ?? []).some((trigger) => normalized.includes(trigger.normalize('NFKC').toLocaleLowerCase()));
}

export function matchTriggeredRules(
  entries: MemoryEntry[],
  userText: string,
  alreadyTriggered: Set<string>,
  limit = 5
): MemoryRecall[] {
  const selected = entries
    .filter((entry) => entry.kind === 'rule' && entry.status === 'confirmed' && entry.ruleMode === 'triggered')
    .filter((entry) => !alreadyTriggered.has(entry.id) && matches(entry, userText))
    .sort((left, right) => {
      const leftProject = left.scopeId === 'global' ? 0 : 1;
      const rightProject = right.scopeId === 'global' ? 0 : 1;
      return rightProject - leftProject || right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
  for (const entry of selected) alreadyTriggered.add(entry.id);
  return selected.map((entry) => ({
    ruleIds: [entry.id],
    content: `Triggered ${entry.scopeId === 'global' ? 'global' : 'project'} rule${entry.title ? ` “${entry.title}”` : ''}:\n${entry.content}`,
    estimatedTokens: estimateTokens(entry.content) + 12
  }));
}
