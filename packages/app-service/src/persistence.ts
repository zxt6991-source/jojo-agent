import type { RunResult } from '@desktop-agent/agent-runtime';
import type { ApprovalDecision, ProtocolError } from '@desktop-agent/server-protocol';

export type SessionMetadataRecord = {
  sessionId: string;
  state: 'creating' | 'active';
  title?: string;
  labels: string[];
  favorite: boolean;
  defaultProviderId?: string;
  defaultModel?: string;
  createdBy?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionMetadataRecord = {
  sessionId: string;
  title?: string;
  labels?: string[];
  favorite?: boolean;
  defaultProviderId?: string;
  defaultModel?: string;
  createdBy?: string;
};

export type EnsureSessionMetadataRecord = CreateSessionMetadataRecord;

export type SessionMetadataPatch = {
  title?: string | null;
  labels?: string[];
  favorite?: boolean;
  defaultProviderId?: string | null;
  defaultModel?: string | null;
  expectedRevision?: number;
};

export type RunRequestMeta = {
  budget?: {
    maxIterations?: number;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    allowPartialOnLimit?: boolean;
  };
};

export type PersistedRunStatus =
  | 'accepted'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type PersistedRunRecord = {
  id: string;
  sessionId: string;
  laneId: string;
  status: PersistedRunStatus;
  providerId: string;
  model: string;
  inputHash: string;
  requestMeta?: RunRequestMeta;
  result?: RunResult;
  error?: ProtocolError;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  version: number;
};

export type CreateRunRecord = {
  id: string;
  sessionId: string;
  laneId: string;
  providerId: string;
  model: string;
  inputHash: string;
  requestMeta?: RunRequestMeta;
};

export type PersistedApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'interrupted';

export type PersistedApprovalPreview = {
  kind: 'create' | 'update' | 'delete';
  path: string;
  additions: number;
  deletions: number;
  truncated?: boolean;
};

export type PersistedApprovalRecord = {
  id: string;
  sessionId: string;
  laneId: string;
  runId: string;
  status: PersistedApprovalStatus;
  toolCallId: string;
  toolName: string;
  reason: string;
  requestHash: string;
  preview?: PersistedApprovalPreview;
  decision?: ApprovalDecision;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
  interruptedReason?: string;
  version: number;
};

export type CreateApprovalRecord = {
  id: string;
  sessionId: string;
  laneId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  requestHash: string;
  preview?: PersistedApprovalPreview;
};

export type IdempotencyClaimInput = {
  principalId: string;
  route: string;
  key: string;
  requestHash: string;
  expiresAt: string;
};

export type IdempotencyClaimResult =
  | { status: 'claimed' }
  | { status: 'pending' }
  | { status: 'completed'; result: unknown };

export type CompleteIdempotencyInput = Omit<IdempotencyClaimInput, 'expiresAt'> & {
  result: unknown;
};

export type AbandonIdempotencyInput = Omit<IdempotencyClaimInput, 'expiresAt'>;

export interface SessionMetadataStore {
  createCreating(input: CreateSessionMetadataRecord): Promise<SessionMetadataRecord>;
  ensureActive(input: EnsureSessionMetadataRecord): Promise<SessionMetadataRecord>;
  activate(sessionId: string): Promise<SessionMetadataRecord>;
  get(sessionId: string): Promise<SessionMetadataRecord | undefined>;
  list(): Promise<SessionMetadataRecord[]>;
  patch(sessionId: string, patch: SessionMetadataPatch): Promise<SessionMetadataRecord>;
  deleteCreating(sessionId: string): Promise<void>;
}

export interface RunStore {
  createAccepted(input: CreateRunRecord): Promise<PersistedRunRecord>;
  get(runId: string): Promise<PersistedRunRecord | undefined>;
  list(sessionId: string, options?: { activeOnly?: boolean }): Promise<PersistedRunRecord[]>;
  listRecoverable(): Promise<PersistedRunRecord[]>;
  markStarting(runId: string, expectedVersion?: number): Promise<PersistedRunRecord>;
  markRunning(runId: string, expectedVersion?: number): Promise<PersistedRunRecord>;
  markCompleted(runId: string, result: RunResult, expectedVersion?: number): Promise<PersistedRunRecord>;
  markFailed(
    runId: string,
    error: ProtocolError,
    result?: RunResult,
    expectedVersion?: number
  ): Promise<PersistedRunRecord>;
  markCancelled(runId: string, result: RunResult, expectedVersion?: number): Promise<PersistedRunRecord>;
  markInterrupted(runId: string, error: ProtocolError, expectedVersion?: number): Promise<PersistedRunRecord>;
}

export interface ApprovalStore {
  createPending(input: CreateApprovalRecord): Promise<PersistedApprovalRecord>;
  get(id: string): Promise<PersistedApprovalRecord | undefined>;
  listPending(sessionId?: string): Promise<PersistedApprovalRecord[]>;
  listRecoverable(): Promise<PersistedApprovalRecord[]>;
  resolve(
    id: string,
    decision: ApprovalDecision,
    principalId?: string,
    expectedVersion?: number
  ): Promise<PersistedApprovalRecord>;
  interrupt(id: string, reason: string, expectedVersion?: number): Promise<PersistedApprovalRecord>;
}

export interface DurableIdempotencyStore {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  complete(input: CompleteIdempotencyInput): Promise<void>;
  abandon(input: AbandonIdempotencyInput): Promise<void>;
}

export interface ServerStateStore {
  readonly sessions: SessionMetadataStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalStore;
  readonly idempotency: DurableIdempotencyStore;
  close(): Promise<void>;
}

type Clock = () => Date;

const activeRunStatuses = new Set<PersistedRunStatus>(['accepted', 'starting', 'running']);
const terminalRunStatuses = new Set<PersistedRunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryServerStateStore implements ServerStateStore {
  private readonly sessionRecords = new Map<string, SessionMetadataRecord>();
  private readonly runRecords = new Map<string, PersistedRunRecord>();
  private readonly approvalRecords = new Map<string, PersistedApprovalRecord>();
  private readonly idempotencyRecords = new Map<string, {
    requestHash: string;
    status: 'pending' | 'completed';
    result?: unknown;
    expiresAt: string;
  }>();

  readonly sessions: SessionMetadataStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalStore;
  readonly idempotency: DurableIdempotencyStore;

  constructor(private readonly now: Clock = () => new Date()) {
    this.sessions = {
      createCreating: async (input) => this.createCreating(input),
      ensureActive: async (input) => this.ensureActive(input),
      activate: async (sessionId) => this.activate(sessionId),
      get: async (sessionId) => this.cloneSession(sessionId),
      list: async () => [...this.sessionRecords.values()].map(clone),
      patch: async (sessionId, patch) => this.patchSession(sessionId, patch),
      deleteCreating: async (sessionId) => {
        if (this.sessionRecords.get(sessionId)?.state === 'creating') this.sessionRecords.delete(sessionId);
      }
    };
    this.runs = {
      createAccepted: async (input) => this.createAccepted(input),
      get: async (runId) => this.cloneRun(runId),
      list: async (sessionId, options) => [...this.runRecords.values()]
        .filter((record) => record.sessionId === sessionId && (!options?.activeOnly || activeRunStatuses.has(record.status)))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(clone),
      listRecoverable: async () => [...this.runRecords.values()]
        .filter((record) => activeRunStatuses.has(record.status))
        .map(clone),
      markStarting: async (id, version) => this.transitionRun(id, ['accepted'], 'starting', {}, version),
      markRunning: async (id, version) => this.transitionRun(id, ['starting'], 'running', {
        startedAt: this.now().toISOString()
      }, version),
      markCompleted: async (id, result, version) => this.transitionRun(
        id, ['running', 'starting'], 'completed', { result }, version
      ),
      markFailed: async (id, error, result, version) => this.transitionRun(
        id, ['accepted', 'starting', 'running'], 'failed', { error, ...(result ? { result } : {}) }, version
      ),
      markCancelled: async (id, result, version) => this.transitionRun(
        id, ['starting', 'running'], 'cancelled', { result }, version
      ),
      markInterrupted: async (id, error, version) => this.transitionRun(
        id, ['accepted', 'starting', 'running'], 'interrupted', { error }, version
      )
    };
    this.approvals = {
      createPending: async (input) => this.createPending(input),
      get: async (id) => this.cloneApproval(id),
      listPending: async (sessionId) => [...this.approvalRecords.values()]
        .filter((record) => record.status === 'pending' && (!sessionId || record.sessionId === sessionId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(clone),
      listRecoverable: async () => [...this.approvalRecords.values()]
        .filter((record) => record.status === 'pending')
        .map(clone),
      resolve: async (id, decision, principalId, version) => this.resolveApproval(id, decision, principalId, version),
      interrupt: async (id, reason, version) => this.interruptApproval(id, reason, version)
    };
    this.idempotency = {
      claim: async (input) => this.claimIdempotency(input),
      complete: async (input) => this.completeIdempotency(input),
      abandon: async (input) => this.abandonIdempotency(input)
    };
  }

  async close(): Promise<void> {}

  private createCreating(input: CreateSessionMetadataRecord): SessionMetadataRecord {
    if (this.sessionRecords.has(input.sessionId)) throw new Error(`server_session_exists: ${input.sessionId}`);
    const timestamp = this.now().toISOString();
    const record: SessionMetadataRecord = {
      sessionId: input.sessionId,
      state: 'creating',
      labels: [...(input.labels ?? [])],
      favorite: input.favorite ?? false,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.defaultProviderId !== undefined ? { defaultProviderId: input.defaultProviderId } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {})
    };
    this.sessionRecords.set(record.sessionId, record);
    return clone(record);
  }

  private ensureActive(input: EnsureSessionMetadataRecord): SessionMetadataRecord {
    const existing = this.sessionRecords.get(input.sessionId);
    if (existing) return clone(existing);
    const timestamp = this.now().toISOString();
    const record: SessionMetadataRecord = {
      sessionId: input.sessionId,
      state: 'active',
      labels: [...(input.labels ?? [])],
      favorite: input.favorite ?? false,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.defaultProviderId !== undefined ? { defaultProviderId: input.defaultProviderId } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {})
    };
    this.sessionRecords.set(record.sessionId, record);
    return clone(record);
  }

  private activate(sessionId: string): SessionMetadataRecord {
    const record = this.requireSession(sessionId);
    if (record.state === 'active') return clone(record);
    record.state = 'active';
    this.bump(record);
    return clone(record);
  }

  private patchSession(sessionId: string, patch: SessionMetadataPatch): SessionMetadataRecord {
    const record = this.requireSession(sessionId);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== record.revision) {
      throw new Error(`revision_conflict: expected ${patch.expectedRevision}, actual ${record.revision}`);
    }
    if (patch.title !== undefined) {
      if (patch.title === null) delete record.title;
      else record.title = patch.title;
    }
    if (patch.labels !== undefined) record.labels = [...patch.labels];
    if (patch.favorite !== undefined) record.favorite = patch.favorite;
    if (patch.defaultProviderId !== undefined) {
      if (patch.defaultProviderId === null) delete record.defaultProviderId;
      else record.defaultProviderId = patch.defaultProviderId;
    }
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel === null) delete record.defaultModel;
      else record.defaultModel = patch.defaultModel;
    }
    this.bump(record);
    return clone(record);
  }

  private createAccepted(input: CreateRunRecord): PersistedRunRecord {
    if (this.runRecords.has(input.id)) throw new Error(`run_exists: ${input.id}`);
    this.requireSession(input.sessionId);
    const timestamp = this.now().toISOString();
    const record: PersistedRunRecord = {
      ...clone(input),
      status: 'accepted',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1
    };
    this.runRecords.set(record.id, record);
    this.bump(this.requireSession(record.sessionId));
    return clone(record);
  }

  private transitionRun(
    id: string,
    allowed: PersistedRunStatus[],
    target: PersistedRunStatus,
    patch: Pick<PersistedRunRecord, 'result' | 'error' | 'startedAt'>,
    expectedVersion?: number
  ): PersistedRunRecord {
    const record = this.runRecords.get(id);
    if (!record) throw new Error(`run_not_found: ${id}`);
    if (record.status === target) return clone(record);
    if (terminalRunStatuses.has(record.status) || !allowed.includes(record.status)) {
      throw new Error(`run_transition_conflict: ${record.status} -> ${target}`);
    }
    if (expectedVersion !== undefined && expectedVersion !== record.version) {
      throw new Error(`run_transition_conflict: expected version ${expectedVersion}, actual ${record.version}`);
    }
    Object.assign(record, clone(patch));
    record.status = target;
    record.version += 1;
    record.updatedAt = this.now().toISOString();
    if (target === 'running' && !record.startedAt) record.startedAt = record.updatedAt;
    if (terminalRunStatuses.has(target)) record.completedAt = record.updatedAt;
    this.bump(this.requireSession(record.sessionId));
    return clone(record);
  }

  private createPending(input: CreateApprovalRecord): PersistedApprovalRecord {
    const existing = this.approvalRecords.get(input.id);
    if (existing) {
      if (existing.requestHash === input.requestHash) return clone(existing);
      throw new Error(`approval_conflict: ${input.id}`);
    }
    const run = this.runRecords.get(input.runId);
    if (!run || run.sessionId !== input.sessionId) throw new Error(`run_not_found: ${input.runId}`);
    const record: PersistedApprovalRecord = {
      ...clone(input),
      status: 'pending',
      createdAt: this.now().toISOString(),
      version: 1
    };
    this.approvalRecords.set(record.id, record);
    this.bump(this.requireSession(record.sessionId));
    return clone(record);
  }

  private resolveApproval(
    id: string,
    decision: ApprovalDecision,
    principalId?: string,
    expectedVersion?: number
  ): PersistedApprovalRecord {
    const record = this.approvalRecords.get(id);
    if (!record) throw new Error(`approval_not_found: ${id}`);
    const target = decision === 'allow' ? 'allowed' : 'denied';
    if (record.status === target && record.decision === decision) return clone(record);
    if (record.status !== 'pending') throw new Error(`approval_already_resolved: ${id}`);
    if (expectedVersion !== undefined && expectedVersion !== record.version) {
      throw new Error(`approval_transition_conflict: ${id}`);
    }
    record.status = target;
    record.decision = decision;
    if (principalId !== undefined) record.resolvedBy = principalId;
    record.resolvedAt = this.now().toISOString();
    record.version += 1;
    this.bump(this.requireSession(record.sessionId));
    return clone(record);
  }

  private interruptApproval(id: string, reason: string, expectedVersion?: number): PersistedApprovalRecord {
    const record = this.approvalRecords.get(id);
    if (!record) throw new Error(`approval_not_found: ${id}`);
    if (record.status === 'interrupted') return clone(record);
    if (record.status !== 'pending') return clone(record);
    if (expectedVersion !== undefined && expectedVersion !== record.version) {
      throw new Error(`approval_transition_conflict: ${id}`);
    }
    record.status = 'interrupted';
    record.interruptedReason = reason;
    record.resolvedAt = this.now().toISOString();
    record.version += 1;
    this.bump(this.requireSession(record.sessionId));
    return clone(record);
  }

  private claimIdempotency(input: IdempotencyClaimInput): IdempotencyClaimResult {
    const key = idempotencyStorageKey(input);
    const existing = this.idempotencyRecords.get(key);
    if (existing && existing.expiresAt <= this.now().toISOString()) this.idempotencyRecords.delete(key);
    const current = this.idempotencyRecords.get(key);
    if (current) {
      if (current.requestHash !== input.requestHash) {
        throw new Error('idempotency_conflict: key was used with a different request');
      }
      if (current.status === 'completed') {
        return { status: 'completed', result: clone(current.result) };
      }
      return { status: 'pending' };
    }
    this.idempotencyRecords.set(key, {
      requestHash: input.requestHash,
      status: 'pending',
      expiresAt: input.expiresAt
    });
    return { status: 'claimed' };
  }

  private completeIdempotency(input: CompleteIdempotencyInput): void {
    const record = this.idempotencyRecords.get(idempotencyStorageKey(input));
    if (!record || record.requestHash !== input.requestHash) {
      throw new Error('idempotency_claim_missing: durable claim is unavailable');
    }
    record.status = 'completed';
    record.result = clone(input.result);
  }

  private abandonIdempotency(input: AbandonIdempotencyInput): void {
    const key = idempotencyStorageKey(input);
    const record = this.idempotencyRecords.get(key);
    if (record?.status === 'pending' && record.requestHash === input.requestHash) {
      this.idempotencyRecords.delete(key);
    }
  }

  private requireSession(sessionId: string): SessionMetadataRecord {
    const record = this.sessionRecords.get(sessionId);
    if (!record) throw new Error(`server_session_metadata_missing: ${sessionId}`);
    return record;
  }

  private bump(record: SessionMetadataRecord): void {
    record.revision += 1;
    record.updatedAt = this.now().toISOString();
  }

  private cloneSession(id: string): SessionMetadataRecord | undefined {
    const record = this.sessionRecords.get(id);
    return record ? clone(record) : undefined;
  }

  private cloneRun(id: string): PersistedRunRecord | undefined {
    const record = this.runRecords.get(id);
    return record ? clone(record) : undefined;
  }

  private cloneApproval(id: string): PersistedApprovalRecord | undefined {
    const record = this.approvalRecords.get(id);
    return record ? clone(record) : undefined;
  }
}

function idempotencyStorageKey(input: { principalId: string; route: string; key: string }): string {
  return `${input.principalId}\u0000${input.route}\u0000${input.key}`;
}
