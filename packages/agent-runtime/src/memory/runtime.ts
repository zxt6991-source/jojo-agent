import type { MemoryRecall, MemorySnapshot, ProjectIdentity } from '@desktop-agent/contracts';

export type MemoryCompactInput = {
  sessionId: string;
  operationId: string;
  snapshotId?: string;
  scopeVersions?: Record<string, number>;
  openTasks: string[];
  decisions: string[];
  memoryWrites: string[];
};

export type MemoryCompactResult = {
  handoff?: { openTasks: string[]; decisions: string[]; memoryWrites: string[] };
  refreshSnapshot: boolean;
};

export type MemoryTurnSettledInput = {
  sessionId: string;
  operationId: string;
  userText: string;
  assistantText?: string;
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
  async beforeCompact(): Promise<MemoryCompactResult> { return { refreshSnapshot: false }; }
  async onTurnSettled(): Promise<void> {}
}
