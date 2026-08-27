import type {
  MemoryHandoff,
  MemoryRecall,
  MemorySnapshot,
  MemoryWarning,
  Message,
  ProjectIdentity
} from '@desktop-agent/contracts';

export type MemoryToolEvent = {
  toolCallId: string;
  effect: 'memory.write' | 'memory.forget' | 'memory.restore';
  scope: 'global' | 'project';
  entryId?: string;
  result: 'success' | 'failed';
};

export type MemoryCompactInput = {
  sessionId: string;
  operationId: string;
  lane: string;
  compactionOrdinal?: number;
  currentSnapshotId: string;
  projectIdentity?: ProjectIdentity;
  messagesToSummarize: Message[];
  retainedTail: Message[];
  previousCompactionSummary?: string;
  memoryToolEvents: MemoryToolEvent[];
  currentSnapshotScopeVersions?: Record<string, number>;
  runtimeOpenTasks?: string[];
  runtimeDecisions?: string[];
  signal: AbortSignal;
};

export type MemoryCompactResult = {
  handoff?: MemoryHandoff;
  refreshSnapshot: boolean;
  currentScopeVersions?: Record<string, number>;
  warnings?: MemoryWarning[];
};

export type MemoryTurnSettledInput = {
  sessionId: string;
  operationId: string;
  userText: string;
  assistantText?: string;
  messages?: Message[];
  projectIdentity?: ProjectIdentity;
  signal?: AbortSignal;
};

export interface MemoryRuntime {
  snapshot(input: {
    sessionId: string;
    operationId: string;
    projectIdentity?: ProjectIdentity;
    contextWindowTokens: number;
    signal: AbortSignal;
  }): Promise<MemorySnapshot>;

  recallTriggered(input: {
    sessionId: string;
    operationId: string;
    snapshotId: string;
    userText: string;
    projectIdentity?: ProjectIdentity;
  }): Promise<MemoryRecall[]>;

  beforeCompact(input: MemoryCompactInput): Promise<MemoryCompactResult>;
  onTurnSettled(input: MemoryTurnSettledInput): Promise<void>;
}

export class NoopMemoryRuntime implements MemoryRuntime {
  static readonly instance = new NoopMemoryRuntime();
  private constructor() {}

  async snapshot(): Promise<MemorySnapshot> {
    return {
      id: 'memory_disabled',
      version: 0,
      scope: { globalScopeId: 'global' },
      content: '',
      sourceEntryIds: [],
      scopeVersions: {},
      estimatedTokens: 0,
      contentHash: ''
    };
  }
  async recallTriggered(): Promise<MemoryRecall[]> { return []; }
  async beforeCompact(): Promise<MemoryCompactResult> {
    return { refreshSnapshot: false, currentScopeVersions: {} };
  }
  async onTurnSettled(): Promise<void> {}
}
