import type {
  AgentEvent,
  HookEnvelope,
  HookTransport,
  Message,
  ProjectIdentity,
  SubAgentMemoryBinding,
  WorkflowMemoryBinding
} from '@desktop-agent/contracts';
import type { RunResult } from '@desktop-agent/contracts/runtime';

export type RunRequest = {
  input: string;
  providerId: string;
  model: string;
  history?: Message[];
  instructions?: string[];
  maxIterations?: number;
  allowPartialOnMaxIterations?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /** Phase-A adapter override for non-workspace scopes. */
  workingDirectory?: string;
  signal?: AbortSignal;
  projectIdentity?: ProjectIdentity;
  memoryBinding?: SubAgentMemoryBinding | WorkflowMemoryBinding;
  hookMeta?: {
    transport?: HookTransport;
    agent?: HookEnvelope['agent'];
    workflow?: HookEnvelope['workflow'];
  };
};

export interface RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

/** Diagnostic compatibility channel; stable consumers should subscribe to RuntimeEventEnvelope. */
export interface TelemetrySink {
  diagnostic(event: AgentEvent): void;
}

