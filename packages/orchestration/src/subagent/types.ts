import type { AgentEvent, SubAgentProfile, UsageTotals } from '@desktop-agent/contracts';

export type LeafAgentRunRequest = {
  id: string;
  sessionId: string;
  workingDirectory: string;
  task: string;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  maxIterations: number;
  timeoutMs: number;
};

export type LeafAgentRunResult = {
  result: string;
  stopReason: string;
  usage: UsageTotals;
  incomplete: boolean;
};

export interface LeafAgentRunner {
  run(
    request: LeafAgentRunRequest,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<LeafAgentRunResult>;
}

export type SubAgentStartRequest = {
  sessionId: string;
  workingDirectory: string;
  task: string;
  label?: string;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  timeoutMs: number;
  maxIterations?: number;
  depth?: number;
};
