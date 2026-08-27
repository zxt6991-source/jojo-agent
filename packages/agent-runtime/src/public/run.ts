import type {
  AgentEvent
} from '@desktop-agent/contracts';
import type { RunResult, RuntimeInput } from '@desktop-agent/contracts/runtime';

export type RunBudget = {
  maxIterations?: number;
  allowPartialOnLimit?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export type RuntimeActor = {
  kind: 'main' | 'subagent' | 'workflow';
  id?: string;
  profile?: string;
};

export type RuntimeWorkflowContext = {
  id: string;
  runId?: string;
  stepId?: string;
};

export type RunRequest = {
  /** Strings remain accepted during the v0.x compatibility window. */
  input: RuntimeInput | string;
  providerId: string;
  model: string;
  instructions?: string[];
  budget?: RunBudget;
  actor?: RuntimeActor;
  workflow?: RuntimeWorkflowContext;
  signal?: AbortSignal;
};

export interface RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

/** Diagnostic compatibility channel; stable consumers should subscribe to RuntimeEventEnvelope. */
export interface TelemetrySink {
  diagnostic(event: AgentEvent, context: { sessionId: string; laneId: string; runId: string }): void;
}

export type { RuntimeInput, RuntimeInputBlock } from '@desktop-agent/contracts/runtime';
