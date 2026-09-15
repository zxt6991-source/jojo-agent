import type { JsonValue } from '../session/types.js';

export type OperationKind = 'run' | 'compaction';

export type OperationMeta = {
  id: string;
  sessionId: string;
  lane: string;
  kind: OperationKind;
  createdAt: number;
  providerId: string;
  model: string;
  maxIterations: number;
  execution?: import('../public/execution.js').OperationExecutionSnapshotV1;
  config?: Record<string, JsonValue>;
};

export type StoredOperation = {
  meta: OperationMeta;
  state: import('./state.js').OperationState;
};
