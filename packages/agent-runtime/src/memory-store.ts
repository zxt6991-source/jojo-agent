import { assertOperationState } from './operation/invariants.js';
import type { OperationMeta, StoredOperation } from './operation/meta.js';
import { isTerminalState, type OperationState } from './operation/state.js';
import type { AgentRuntimeStore, Clock } from './store.js';
import type { AppendEntryInput, LaneState, Session, SessionEntry } from './session/types.js';
import type { UsageRecord } from './usage/types.js';

const systemClock: Clock = { now: () => Date.now() };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function laneKey(sessionId: string, lane: string): string {
  return `${sessionId}\u0000${lane}`;
}

export class MemoryAgentRuntimeStore implements AgentRuntimeStore {
  private readonly sessions = new Map<string, Session>();
  private readonly entries = new Map<string, SessionEntry>();
  private readonly nextSequence = new Map<string, number>();
  private readonly lanes = new Map<string, LaneState>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly usage: UsageRecord[] = [];

  constructor(private readonly clock: Clock = systemClock) {}

  async createSession(session: Session): Promise<void> {
    if (this.sessions.has(session.id)) throw new Error(`runtime_session_exists: ${session.id}`);
    this.sessions.set(session.id, clone(session));
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()]
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.nextSequence.delete(sessionId);
    for (const [id, entry] of this.entries) if (entry.sessionId === sessionId) this.entries.delete(id);
    for (const [key, lane] of this.lanes) if (lane.sessionId === sessionId) this.lanes.delete(key);
    for (const [id, operation] of this.operations) {
      if (operation.meta.sessionId === sessionId) this.operations.delete(id);
    }
    for (let index = this.usage.length - 1; index >= 0; index -= 1) {
      if (this.usage[index]?.sessionId === sessionId) this.usage.splice(index, 1);
    }
  }

  async appendEntry(input: AppendEntryInput): Promise<SessionEntry> {
    this.requireSession(input.sessionId);
    if (this.entries.has(input.id)) throw new Error(`runtime_entry_exists: ${input.id}`);
    if (input.parentId) {
      const parent = this.entries.get(input.parentId);
      if (!parent || parent.sessionId !== input.sessionId) throw new Error(`runtime_parent_not_found: ${input.parentId}`);
    }
    const seq = this.nextSequence.get(input.sessionId) ?? 1;
    const entry = { ...clone(input), seq, createdAt: this.clock.now() } as SessionEntry;
    this.entries.set(entry.id, entry);
    this.nextSequence.set(input.sessionId, seq + 1);
    return clone(entry);
  }

  async getEntry(id: string): Promise<SessionEntry | null> {
    const entry = this.entries.get(id);
    return entry ? clone(entry) : null;
  }

  async readPath(leafId: string | null): Promise<SessionEntry[]> {
    if (leafId === null) return [];
    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let id: string | null = leafId;
    while (id) {
      if (visited.has(id)) throw new Error(`runtime_entry_cycle: ${id}`);
      visited.add(id);
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`runtime_entry_not_found: ${id}`);
      path.push(clone(entry));
      id = entry.parentId;
    }
    return path.reverse();
  }

  async getLane(sessionId: string, lane: string): Promise<LaneState | null> {
    const state = this.lanes.get(laneKey(sessionId, lane));
    return state ? clone(state) : null;
  }

  async listLanes(sessionId: string): Promise<LaneState[]> {
    return [...this.lanes.values()]
      .filter((lane) => lane.sessionId === sessionId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  async saveLane(lane: LaneState): Promise<void> {
    this.requireSession(lane.sessionId);
    if (!lane.name) throw new Error('runtime_lane_name_required');
    const key = laneKey(lane.sessionId, lane.name);
    const existing = this.lanes.get(key);
    if (existing?.currentOperationId && lane.currentOperationId !== existing.currentOperationId) {
      throw new Error(`runtime_lane_busy: ${lane.name}`);
    }
    if (lane.leafId) {
      const leaf = this.entries.get(lane.leafId);
      if (!leaf || leaf.sessionId !== lane.sessionId) throw new Error(`runtime_lane_leaf_not_found: ${lane.leafId}`);
    }
    if (lane.currentOperationId) {
      const operation = this.operations.get(lane.currentOperationId);
      if (!operation || operation.meta.sessionId !== lane.sessionId || operation.meta.lane !== lane.name) {
        throw new Error(`runtime_lane_operation_not_found: ${lane.currentOperationId}`);
      }
    }
    this.lanes.set(key, clone(lane));
  }

  async startOperation(meta: OperationMeta, initialState: OperationState): Promise<void> {
    this.requireSession(meta.sessionId);
    if (this.operations.has(meta.id)) throw new Error(`runtime_operation_exists: ${meta.id}`);
    if (initialState.operationId !== meta.id || initialState.lane !== meta.lane) {
      throw new Error('runtime_operation_identity_mismatch');
    }
    if (isTerminalState(initialState)) throw new Error('runtime_operation_initial_state_terminal');
    assertOperationState(initialState);
    const key = laneKey(meta.sessionId, meta.lane);
    const lane = this.lanes.get(key);
    if (!lane) throw new Error(`runtime_lane_not_found: ${meta.lane}`);
    if (lane.currentOperationId) throw new Error(`runtime_lane_busy: ${meta.lane}`);
    this.operations.set(meta.id, { meta: clone(meta), state: clone(initialState) });
    this.lanes.set(key, { ...lane, currentOperationId: meta.id });
  }

  async loadOperation(operationId: string): Promise<StoredOperation | null> {
    const operation = this.operations.get(operationId);
    return operation ? clone(operation) : null;
  }

  async saveOperationState(state: OperationState): Promise<void> {
    assertOperationState(state);
    const operation = this.operations.get(state.operationId);
    if (!operation) throw new Error(`runtime_operation_not_found: ${state.operationId}`);
    if (operation.meta.lane !== state.lane) throw new Error('runtime_operation_lane_mismatch');
    this.operations.set(state.operationId, { meta: operation.meta, state: clone(state) });
    if (isTerminalState(state)) {
      const key = laneKey(operation.meta.sessionId, operation.meta.lane);
      const lane = this.lanes.get(key);
      if (lane?.currentOperationId === state.operationId) {
        this.lanes.set(key, { ...lane, currentOperationId: null });
      }
    }
  }

  async appendUsage(usage: UsageRecord): Promise<void> {
    this.requireSession(usage.sessionId);
    if (this.usage.some((record) => record.id === usage.id)) throw new Error(`runtime_usage_exists: ${usage.id}`);
    this.usage.push(clone(usage));
  }

  async readUsage(sessionId: string): Promise<UsageRecord[]> {
    return this.usage.filter((record) => record.sessionId === sessionId).map(clone);
  }

  private requireSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`runtime_session_not_found: ${sessionId}`);
  }
}
