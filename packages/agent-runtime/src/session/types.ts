import type { InjectingHookEvent, MemoryHandoffItem, Message } from '@desktop-agent/contracts';
import type { UsageRecord } from '../usage/types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Session = {
  id: string;
  createdAt: number;
  metadata?: Record<string, JsonValue>;
};

export interface EntryBase {
  id: string;
  sessionId: string;
  seq: number;
  parentId: string | null;
  createdAt: number;
}

export type MessageEntry = EntryBase & {
  type: 'message';
  message: Message;
};

export type CompactionEntry = EntryBase & {
  type: 'compaction';
  summary: string;
  retainedTail: Message[];
  tokensBefore: number;
  usage?: UsageRecord;
};

export type BranchSummaryEntry = EntryBase & {
  type: 'branch_summary';
  summary: string;
};

export type ModelChangeEntry = EntryBase & {
  type: 'model_change';
  providerId: string;
  model: string;
};

export type ActiveToolsChangeEntry = EntryBase & {
  type: 'active_tools_change';
  toolNames: string[];
};

export type CustomEntry = EntryBase & {
  type: 'custom';
  namespace: string;
  payload: JsonValue;
};

export type HookContextEntry = EntryBase & {
  type: 'hook_context';
  event: InjectingHookEvent;
  hookIds: string[];
  text: string;
  subjectId?: string;
};

export type MemorySnapshotEntry = EntryBase & {
  type: 'memory_snapshot';
  snapshotId: string;
  content: string;
  contentHash: string;
  sourceEntryIds: string[];
  scopeVersions: Record<string, number>;
  estimatedTokens: number;
  refreshedBy: 'session_start' | 'compaction' | 'manual';
  derivedFromSnapshotId?: string;
};

export type MemoryHandoffEntry = EntryBase & {
  type: 'memory_handoff';
  handoffId: string;
  compactionOperationId: string;
  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
  memoryWrites: MemoryHandoffItem[];
  contentHash: string;
};

export type MemoryRecallEntry = EntryBase & {
  type: 'memory_recall';
  snapshotId: string;
  ruleIds: string[];
  userMessageId: string;
  content: string;
  estimatedTokens: number;
};

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ActiveToolsChangeEntry
  | HookContextEntry
  | MemorySnapshotEntry
  | MemoryHandoffEntry
  | MemoryRecallEntry
  | CustomEntry;

export type AppendEntryInput = SessionEntry extends infer Entry
  ? Entry extends SessionEntry ? Omit<Entry, 'seq' | 'createdAt'> : never
  : never;

export type LaneState = {
  sessionId: string;
  name: string;
  leafId: string | null;
  currentOperationId: string | null;
};
