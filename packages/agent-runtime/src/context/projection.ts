import type { Message } from '@desktop-agent/contracts';
import type { CompactionEntry, SessionEntry } from '../session/types.js';

function summaryMessage(entry: CompactionEntry): Message {
  return {
    id: `${entry.id}:summary`,
    role: 'user',
    createdAt: new Date(entry.createdAt).toISOString(),
    metadata: { internal: true },
    content: [{
      type: 'text',
      text: `[Compacted conversation context]\n${entry.summary}\n[End compacted context]`
    }]
  };
}

/** Projects immutable durable history into the message sequence sent to a provider. */
export function projectEntriesToMessages(entries: SessionEntry[]): Message[] {
  let latestCompaction = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === 'compaction') {
      latestCompaction = index;
      break;
    }
  }

  if (latestCompaction < 0) {
    return entries.flatMap((entry) => entry.type === 'message' ? [structuredClone(entry.message)] : []);
  }

  const compaction = entries[latestCompaction] as CompactionEntry;
  const subsequent = entries.slice(latestCompaction + 1)
    .flatMap((entry) => entry.type === 'message' ? [structuredClone(entry.message)] : []);
  return [
    summaryMessage(compaction),
    ...structuredClone(compaction.retainedTail),
    ...subsequent
  ];
}
