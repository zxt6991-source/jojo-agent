import { createHash } from 'node:crypto';
import type { MemoryHandoff, MemoryHandoffItem } from '@desktop-agent/contracts';
import type { MemoryCompactInput } from '@desktop-agent/agent-runtime';

function stableItems(items: MemoryHandoffItem[]): MemoryHandoffItem[] {
  return [...items].sort((left, right) => {
    const source = left.source.localeCompare(right.source);
    if (source !== 0) return source;
    const entry = (left.sourceEntryId ?? '').localeCompare(right.sourceEntryId ?? '');
    return entry !== 0 ? entry : left.text.localeCompare(right.text);
  });
}

function hash(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function memoryHandoffId(input: Pick<MemoryCompactInput,
  'sessionId' | 'operationId' | 'lane' | 'compactionOrdinal'
>): string {
  return `mhf_${hash([
    input.sessionId,
    input.operationId,
    input.lane,
    input.compactionOrdinal ?? 1
  ])}`;
}

export function buildMemoryHandoff(input: {
  compact: MemoryCompactInput;
  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
  memoryWrites: MemoryHandoffItem[];
  createdAt?: number;
}): MemoryHandoff {
  const body = {
    openTasks: stableItems(input.openTasks),
    decisions: stableItems(input.decisions),
    memoryWrites: stableItems(input.memoryWrites)
  };
  return {
    id: memoryHandoffId(input.compact),
    sessionId: input.compact.sessionId,
    operationId: input.compact.operationId,
    ...body,
    createdAt: input.createdAt ?? Date.now(),
    contentHash: hash(body)
  };
}
