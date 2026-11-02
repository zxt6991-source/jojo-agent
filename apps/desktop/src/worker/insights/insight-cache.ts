import type { ConversationSemanticSnapshot } from '../conversation-map-service';

const MAX_ENTRIES = 4;
const MAX_BYTES = 16 * 1024 * 1024;
const TTL_MS = 15 * 60_000;
type Entry = { snapshot: ConversationSemanticSnapshot; expiresAt: number; bytes: number };

/** Worker-local LRU. No SQLite, disk, chat, or Memory side effects. */
export class InsightSemanticCache {
  private readonly entries = new Map<string, Entry>();

  get(key: string, now = Date.now()): ConversationSemanticSnapshot | undefined {
    this.expire(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    // Map rendering can alter topic/event ordering; isolate it from shared candidates.
    return structuredClone(entry.snapshot);
  }

  set(key: string, snapshot: ConversationSemanticSnapshot, now = Date.now()): void {
    this.expire(now);
    // A successful batch can still lose the user evidence needed by another
    // perspective. Retry rejected candidates and failed turns. Fixed source
    // limits are deterministic, remain visible in coverage, and are fingerprinted;
    // paying for identical extraction again cannot restore their missing text.
    // Failed topic grouping must be retried too: fragmented labels cannot prove
    // that a topic lacks independent user messages for the blind-spot view.
    if (!isReusableSemanticSnapshot(snapshot)) {
      this.entries.delete(key);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify({ ...snapshot, sourceTexts: [...snapshot.sourceTexts], proposedSummaries: [...snapshot.proposedSummaries] }));
    if (bytes > MAX_BYTES) return;
    this.entries.delete(key);
    while (this.entries.size >= MAX_ENTRIES || [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) + bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { snapshot: structuredClone(snapshot), bytes, expiresAt: now + TTL_MS });
  }

  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  private expire(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

export function isReusableSemanticSnapshot(snapshot: ConversationSemanticSnapshot): boolean {
  return snapshot.omittedTurnCount === 0 && snapshot.omittedEventCount === 0 && !snapshot.topicGroupingIncomplete;
}
