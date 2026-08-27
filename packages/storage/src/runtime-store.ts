import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  assertOperationState,
  isTerminalState,
  type AgentRuntimeStore,
  type AppendEntryInput,
  type Clock,
  type LaneState,
  type OperationMeta,
  type OperationState,
  type Session,
  type SessionEntry,
  type StoredOperation,
  type UsageRecord
} from '@desktop-agent/agent-runtime/spi';

export const MAX_RUNTIME_JOURNAL_BYTES = 20 * 1024 * 1024;

type RuntimeRecord =
  | { schemaVersion: 1; type: 'session.created'; createdAt: number; session: Session }
  | { schemaVersion: 1; type: 'entry.appended'; createdAt: number; entry: SessionEntry }
  | { schemaVersion: 1; type: 'lane.saved'; createdAt: number; lane: LaneState }
  | {
      schemaVersion: 1;
      type: 'operation.started';
      createdAt: number;
      operationId: string;
      meta: OperationMeta;
      state: OperationState;
    }
  | {
      schemaVersion: 1;
      type: 'operation.state';
      createdAt: number;
      operationId: string;
      state: OperationState;
    }
  | { schemaVersion: 1; type: 'usage.appended'; createdAt: number; usage: UsageRecord };

type RuntimeSnapshot = {
  session: Session | null;
  entries: Map<string, SessionEntry>;
  lanes: Map<string, LaneState>;
  operations: Map<string, StoredOperation>;
  usage: UsageRecord[];
  warnings: string[];
};

const systemClock: Clock = { now: () => Date.now() };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptySnapshot(): RuntimeSnapshot {
  return {
    session: null,
    entries: new Map(),
    lanes: new Map(),
    operations: new Map(),
    usage: [],
    warnings: []
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSession(value: unknown): value is Session {
  return isObject(value) && typeof value.id === 'string' && Number.isFinite(value.createdAt);
}

function isEntry(value: unknown): value is SessionEntry {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.type === 'string'
    && Number.isInteger(value.seq)
    && Number.isFinite(value.createdAt)
    && (value.parentId === null || typeof value.parentId === 'string');
}

function isLane(value: unknown): value is LaneState {
  return isObject(value)
    && typeof value.sessionId === 'string'
    && typeof value.name === 'string'
    && (value.leafId === null || typeof value.leafId === 'string')
    && (value.currentOperationId === null || typeof value.currentOperationId === 'string');
}

function isMeta(value: unknown): value is OperationMeta {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.lane === 'string'
    && (value.kind === 'run' || value.kind === 'compaction')
    && Number.isFinite(value.createdAt)
    && typeof value.providerId === 'string'
    && typeof value.model === 'string'
    && Number.isInteger(value.maxIterations);
}

function isState(value: unknown): value is OperationState {
  if (
    !isObject(value)
    || typeof value.phase !== 'string'
    || typeof value.operationId !== 'string'
    || typeof value.lane !== 'string'
    || ![
      'ready', 'model_pending', 'tools', 'checkpoint', 'final_response',
      'completed', 'failed', 'aborted', 'suspended'
    ].includes(value.phase)
  ) return false;
  if (
    ['ready', 'model_pending', 'tools', 'checkpoint', 'final_response'].includes(value.phase)
    && (!Number.isInteger(value.iteration) || !Number.isInteger(value.outputContinuations) || !isObject(value.progress))
  ) return false;
  if (
    value.phase === 'model_pending'
    && (typeof value.responseEntryId !== 'string' || typeof value.usageId !== 'string' || !isObject(value.request))
  ) return false;
  if (value.phase === 'tools' && (!Array.isArray(value.calls) || !Number.isInteger(value.currentIndex))) return false;
  try {
    assertOperationState(value as OperationState);
    return true;
  } catch {
    return false;
  }
}

function isUsage(value: unknown): value is UsageRecord {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && ['model', 'tool', 'compaction', 'recovery'].includes(String(value.cause))
    && Number.isFinite(value.createdAt);
}

function parseRecord(value: unknown): RuntimeRecord | null {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.type !== 'string' || !Number.isFinite(value.createdAt)) {
    return null;
  }
  if (value.type === 'session.created' && isSession(value.session)) return value as RuntimeRecord;
  if (value.type === 'entry.appended' && isEntry(value.entry)) return value as RuntimeRecord;
  if (value.type === 'lane.saved' && isLane(value.lane)) return value as RuntimeRecord;
  if (
    value.type === 'operation.started'
    && typeof value.operationId === 'string'
    && isMeta(value.meta)
    && isState(value.state)
  ) return value as RuntimeRecord;
  if (value.type === 'operation.state' && typeof value.operationId === 'string' && isState(value.state)) {
    return value as RuntimeRecord;
  }
  if (value.type === 'usage.appended' && isUsage(value.usage)) return value as RuntimeRecord;
  return null;
}

function applyRecord(snapshot: RuntimeSnapshot, record: RuntimeRecord): void {
  switch (record.type) {
    case 'session.created':
      snapshot.session = record.session;
      break;
    case 'entry.appended':
      snapshot.entries.set(record.entry.id, record.entry);
      break;
    case 'lane.saved':
      snapshot.lanes.set(record.lane.name, record.lane);
      break;
    case 'operation.started': {
      snapshot.operations.set(record.operationId, { meta: record.meta, state: record.state });
      const lane = snapshot.lanes.get(record.meta.lane);
      if (lane) snapshot.lanes.set(lane.name, { ...lane, currentOperationId: record.operationId });
      break;
    }
    case 'operation.state': {
      const operation = snapshot.operations.get(record.operationId);
      if (!operation || operation.meta.lane !== record.state.lane) break;
      snapshot.operations.set(record.operationId, { meta: operation.meta, state: record.state });
      if (isTerminalState(record.state)) {
        const lane = snapshot.lanes.get(operation.meta.lane);
        if (lane?.currentOperationId === record.operationId) {
          snapshot.lanes.set(lane.name, { ...lane, currentOperationId: null });
        }
      }
      break;
    }
    case 'usage.appended':
      snapshot.usage.push(record.usage);
      break;
  }
}

export class JsonlAgentRuntimeStore implements AgentRuntimeStore {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly operationSessions = new Map<string, string>();

  constructor(
    private readonly directory: string,
    private readonly clock: Clock = systemClock
  ) {}

  async createSession(session: Session): Promise<void> {
    await this.enqueue(session.id, async (snapshot) => {
      if (snapshot.session) throw new Error(`runtime_session_exists: ${session.id}`);
      await this.append(session.id, {
        schemaVersion: 1, type: 'session.created', createdAt: this.clock.now(), session: clone(session)
      });
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const snapshot = await this.loadSnapshot(sessionId);
    return snapshot.session ? clone(snapshot.session) : null;
  }

  async listSessions(): Promise<Session[]> {
    const sessions = await Promise.all((await this.sessionIds()).map((id) => this.getSession(id)));
    return sessions
      .filter((session): session is Session => session !== null)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.writes.get(sessionId);
    const snapshot = await this.readSnapshot(sessionId);
    for (const operationId of snapshot.operations.keys()) this.operationSessions.delete(operationId);
    try { await unlink(this.file(sessionId)); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async appendEntry(input: AppendEntryInput): Promise<SessionEntry> {
    let result: SessionEntry | undefined;
    await this.enqueue(input.sessionId, async (snapshot) => {
      this.requireSession(snapshot, input.sessionId);
      if (snapshot.entries.has(input.id)) throw new Error(`runtime_entry_exists: ${input.id}`);
      if (input.parentId) {
        const parent = snapshot.entries.get(input.parentId);
        if (!parent || parent.sessionId !== input.sessionId) throw new Error(`runtime_parent_not_found: ${input.parentId}`);
      }
      const seq = Math.max(0, ...[...snapshot.entries.values()].map((entry) => entry.seq)) + 1;
      result = { ...clone(input), seq, createdAt: this.clock.now() } as SessionEntry;
      await this.append(input.sessionId, {
        schemaVersion: 1, type: 'entry.appended', createdAt: this.clock.now(), entry: result
      });
    });
    return clone(result!);
  }

  async getEntry(id: string): Promise<SessionEntry | null> {
    for (const sessionId of await this.sessionIds()) {
      const entry = (await this.loadSnapshot(sessionId)).entries.get(id);
      if (entry) return clone(entry);
    }
    return null;
  }

  async readPath(leafId: string | null): Promise<SessionEntry[]> {
    if (leafId === null) return [];
    const leaf = await this.getEntry(leafId);
    if (!leaf) throw new Error(`runtime_entry_not_found: ${leafId}`);
    const snapshot = await this.loadSnapshot(leaf.sessionId);
    const result: SessionEntry[] = [];
    const visited = new Set<string>();
    let id: string | null = leafId;
    while (id) {
      if (visited.has(id)) throw new Error(`runtime_entry_cycle: ${id}`);
      visited.add(id);
      const entry = snapshot.entries.get(id);
      if (!entry) throw new Error(`runtime_entry_not_found: ${id}`);
      result.push(clone(entry));
      id = entry.parentId;
    }
    return result.reverse();
  }

  async getLane(sessionId: string, lane: string): Promise<LaneState | null> {
    const state = (await this.loadSnapshot(sessionId)).lanes.get(lane);
    return state ? clone(state) : null;
  }

  async listLanes(sessionId: string): Promise<LaneState[]> {
    return [...(await this.loadSnapshot(sessionId)).lanes.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  async saveLane(lane: LaneState): Promise<void> {
    await this.enqueue(lane.sessionId, async (snapshot) => {
      this.requireSession(snapshot, lane.sessionId);
      if (!lane.name) throw new Error('runtime_lane_name_required');
      const existing = snapshot.lanes.get(lane.name);
      if (existing?.currentOperationId && lane.currentOperationId !== existing.currentOperationId) {
        throw new Error(`runtime_lane_busy: ${lane.name}`);
      }
      if (lane.leafId) {
        const leaf = snapshot.entries.get(lane.leafId);
        if (!leaf || leaf.sessionId !== lane.sessionId) throw new Error(`runtime_lane_leaf_not_found: ${lane.leafId}`);
      }
      if (lane.currentOperationId) {
        const operation = snapshot.operations.get(lane.currentOperationId);
        if (!operation || operation.meta.sessionId !== lane.sessionId || operation.meta.lane !== lane.name) {
          throw new Error(`runtime_lane_operation_not_found: ${lane.currentOperationId}`);
        }
      }
      await this.append(lane.sessionId, {
        schemaVersion: 1, type: 'lane.saved', createdAt: this.clock.now(), lane: clone(lane)
      });
    });
  }

  async startOperation(meta: OperationMeta, initialState: OperationState): Promise<void> {
    await this.enqueue(meta.sessionId, async (snapshot) => {
      this.requireSession(snapshot, meta.sessionId);
      if (snapshot.operations.has(meta.id)) throw new Error(`runtime_operation_exists: ${meta.id}`);
      if (initialState.operationId !== meta.id || initialState.lane !== meta.lane) {
        throw new Error('runtime_operation_identity_mismatch');
      }
      if (isTerminalState(initialState)) throw new Error('runtime_operation_initial_state_terminal');
      assertOperationState(initialState);
      const lane = snapshot.lanes.get(meta.lane);
      if (!lane) throw new Error(`runtime_lane_not_found: ${meta.lane}`);
      if (lane.currentOperationId) throw new Error(`runtime_lane_busy: ${meta.lane}`);
      await this.append(meta.sessionId, {
        schemaVersion: 1, type: 'operation.started', operationId: meta.id,
        createdAt: this.clock.now(), meta: clone(meta), state: clone(initialState)
      });
      this.operationSessions.set(meta.id, meta.sessionId);
    });
  }

  async loadOperation(operationId: string): Promise<StoredOperation | null> {
    const sessionId = await this.findOperationSession(operationId);
    if (!sessionId) return null;
    const operation = (await this.loadSnapshot(sessionId)).operations.get(operationId);
    return operation ? clone(operation) : null;
  }

  async saveOperationState(state: OperationState): Promise<void> {
    assertOperationState(state);
    const sessionId = await this.findOperationSession(state.operationId);
    if (!sessionId) throw new Error(`runtime_operation_not_found: ${state.operationId}`);
    await this.enqueue(sessionId, async (snapshot) => {
      const operation = snapshot.operations.get(state.operationId);
      if (!operation) throw new Error(`runtime_operation_not_found: ${state.operationId}`);
      if (operation.meta.lane !== state.lane) throw new Error('runtime_operation_lane_mismatch');
      await this.append(sessionId, {
        schemaVersion: 1, type: 'operation.state', operationId: state.operationId,
        createdAt: this.clock.now(), state: clone(state)
      });
    });
  }

  async appendUsage(usage: UsageRecord): Promise<void> {
    await this.enqueue(usage.sessionId, async (snapshot) => {
      this.requireSession(snapshot, usage.sessionId);
      if (snapshot.usage.some((record) => record.id === usage.id)) throw new Error(`runtime_usage_exists: ${usage.id}`);
      await this.append(usage.sessionId, {
        schemaVersion: 1, type: 'usage.appended', createdAt: this.clock.now(), usage: clone(usage)
      });
    });
  }

  async readUsage(sessionId: string): Promise<UsageRecord[]> {
    return (await this.loadSnapshot(sessionId)).usage.map(clone);
  }

  async getWarnings(sessionId: string): Promise<string[]> {
    return [...(await this.loadSnapshot(sessionId)).warnings];
  }

  private file(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error(`runtime_invalid_session_id: ${sessionId}`);
    return path.join(this.directory, `${sessionId}.jsonl`);
  }

  private async sessionIds(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    return (await readdir(this.directory))
      .filter((file) => /^[a-zA-Z0-9_-]+\.jsonl$/u.test(file))
      .map((file) => file.slice(0, -6));
  }

  private async loadSnapshot(sessionId: string): Promise<RuntimeSnapshot> {
    await this.writes.get(sessionId);
    return this.readSnapshot(sessionId);
  }

  private async readSnapshot(sessionId: string): Promise<RuntimeSnapshot> {
    const snapshot = emptySnapshot();
    let content: string;
    try { content = await readFile(this.file(sessionId), 'utf8'); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return snapshot;
      throw error;
    }
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch {
        snapshot.warnings.push(`Ignored incomplete or invalid runtime record at line ${index + 1}.`);
        continue;
      }
      const record = parseRecord(raw);
      if (!record) {
        snapshot.warnings.push(`Ignored unsupported runtime record at line ${index + 1}.`);
        continue;
      }
      applyRecord(snapshot, record);
      if (record.type === 'operation.started') this.operationSessions.set(record.operationId, record.meta.sessionId);
    }
    return snapshot;
  }

  private async findOperationSession(operationId: string): Promise<string | null> {
    const known = this.operationSessions.get(operationId);
    if (known) return known;
    for (const sessionId of await this.sessionIds()) {
      if ((await this.loadSnapshot(sessionId)).operations.has(operationId)) {
        this.operationSessions.set(operationId, sessionId);
        return sessionId;
      }
    }
    return null;
  }

  private enqueue(sessionId: string, work: (snapshot: RuntimeSnapshot) => Promise<void>): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => work(await this.readSnapshot(sessionId)));
    this.writes.set(sessionId, next);
    void next.finally(() => { if (this.writes.get(sessionId) === next) this.writes.delete(sessionId); }).catch(() => undefined);
    return next;
  }

  private async append(sessionId: string, record: RuntimeRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = this.file(sessionId);
    let size = 0;
    try { size = (await stat(file)).size; } catch { /* first record */ }
    const line = `${JSON.stringify(record)}\n`;
    if (size + Buffer.byteLength(line) > MAX_RUNTIME_JOURNAL_BYTES) {
      throw new Error(`runtime_journal_limit: Journal exceeds ${MAX_RUNTIME_JOURNAL_BYTES} bytes.`);
    }
    await appendFile(file, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  }

  private requireSession(snapshot: RuntimeSnapshot, sessionId: string): void {
    if (!snapshot.session) throw new Error(`runtime_session_not_found: ${sessionId}`);
  }
}
