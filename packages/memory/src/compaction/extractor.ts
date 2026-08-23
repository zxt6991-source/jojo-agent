import type { MemoryHandoffItem } from '@desktop-agent/contracts';
import type { MemoryToolEvent } from '@desktop-agent/agent-runtime';

function unique(items: MemoryHandoffItem[]): MemoryHandoffItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}\0${item.sourceEntryId ?? ''}\0${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractScratchpadHandoff(content: string): {
  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
} {
  const openTasks: MemoryHandoffItem[] = [];
  const decisions: MemoryHandoffItem[] = [];
  let section = '';
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      section = heading[1]!.trim().toLocaleLowerCase();
      continue;
    }
    const task = /^[-*]\s+\[\s\]\s+(.+)$/u.exec(line);
    if (task) {
      openTasks.push({ text: task[1]!.trim(), source: 'scratchpad' });
      continue;
    }
    if (/decision|决策|决定/u.test(section)) {
      const decision = /^[-*]\s+(.+)$/u.exec(line);
      if (decision) decisions.push({ text: decision[1]!.trim(), source: 'scratchpad' });
    }
  }
  return { openTasks: unique(openTasks).slice(0, 100), decisions: unique(decisions).slice(0, 100) };
}

export function extractMemoryToolHandoff(events: MemoryToolEvent[]): MemoryHandoffItem[] {
  const verbs = {
    memory_write: 'written',
    memory_forget: 'forgotten',
    memory_restore: 'restored'
  } as const;
  return unique(events.filter((event) => event.result === 'success').map((event) => ({
    text: `${event.entryId ?? event.toolCallId} ${verbs[event.toolName]} (${event.scope})`,
    source: 'memory_tool' as const,
    ...(event.entryId ? { sourceEntryId: event.entryId } : {})
  })));
}

export function runtimeItems(values: string[] | undefined): MemoryHandoffItem[] {
  return unique((values ?? []).map((text) => ({ text: text.trim(), source: 'runtime' as const })))
    .filter((item) => item.text)
    .slice(0, 100);
}
