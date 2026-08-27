import type { OperationMeta, StoredOperation } from './operation/meta.js';
import type { OperationState } from './operation/state.js';
import type { AppendEntryInput, LaneState, Session, SessionEntry } from './session/types.js';
import type { UsageRecord } from './usage/types.js';

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  next(prefix?: string): string;
}

export interface AgentRuntimeStore {
  createSession(session: Session): Promise<void>;
  getSession(sessionId: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  deleteSession(sessionId: string): Promise<void>;
  appendEntry(input: AppendEntryInput): Promise<SessionEntry>;
  getEntry(id: string): Promise<SessionEntry | null>;
  readPath(leafId: string | null): Promise<SessionEntry[]>;
  getLane(sessionId: string, lane: string): Promise<LaneState | null>;
  listLanes(sessionId: string): Promise<LaneState[]>;
  saveLane(lane: LaneState): Promise<void>;
  startOperation(meta: OperationMeta, initialState: OperationState): Promise<void>;
  loadOperation(operationId: string): Promise<StoredOperation | null>;
  saveOperationState(state: OperationState): Promise<void>;
  appendUsage(usage: UsageRecord): Promise<void>;
  readUsage(sessionId: string): Promise<UsageRecord[]>;
}
