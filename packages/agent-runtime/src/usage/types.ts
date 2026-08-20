export type UsageCause = 'model' | 'tool' | 'compaction' | 'recovery';

export type UsageRecord = {
  id: string;
  sessionId: string;
  operationId?: string;
  lane?: string;
  cause: UsageCause;
  providerId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  createdAt: number;
};
