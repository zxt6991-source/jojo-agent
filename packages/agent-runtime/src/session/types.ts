import type { InjectingHookEvent, Message } from '@desktop-agent/contracts';
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

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ActiveToolsChangeEntry
  | HookContextEntry
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
