import type {
  AgentEvent,
  HookRuntime,
  IsolationConfig,
  SubAgentMemoryBinding,
  SubAgentProfile,
  UsageTotals,
  WorkflowMemoryBinding,
  WorkflowResourceGroup
} from '@desktop-agent/contracts';
import type { AgentToolPolicy } from './tool-policy.js';

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
  tools?: AgentToolPolicy;
  readOnly?: boolean;
  outputSchema?: Record<string, unknown>;
  isolation?: IsolationConfig;
  continuable?: boolean;
  runtimeLane?: {
    name: string;
    parentLane?: string;
  };
  hooks?: HookRuntime;
  memoryBinding?: SubAgentMemoryBinding | WorkflowMemoryBinding;
};

export type LeafAgentRunResult = {
  result: string;
  stopReason: string;
  model?: string;
  continuationId?: string;
  usage: UsageTotals;
  incomplete: boolean;
};

export interface LeafAgentRunner {
  /** Stable Runtime Lane is the continuation identity; repeat run() with the same lane. */
  readonly laneBasedContinuation?: boolean;
  run(
    request: LeafAgentRunRequest,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<LeafAgentRunResult>;
  continue?(
    continuationId: string,
    task: string,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<LeafAgentRunResult>;
  close?(continuationId: string): Promise<void>;
}

export type SubAgentStartRequest = {
  sessionId: string;
  workingDirectory: string;
  task: string;
  label?: string;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  timeoutMs?: number;
  maxIterations?: number;
  tools?: AgentToolPolicy;
  readOnly?: boolean;
  outputSchema?: Record<string, unknown>;
  isolation?: IsolationConfig;
  resources?: WorkflowResourceGroup;
  depth?: number;
  parent?: SpawnParent;
  owner?: SpawnOwner;
  memoryBinding?: SubAgentMemoryBinding;
};

export type SpawnParent = {
  actor: 'main' | 'team_member' | 'workflow' | 'subagent';
  actorId?: string;
  teamId?: string;
  parentSpawnId?: string;
  depth: number;
};

export type SpawnOwner = {
  kind: 'main' | 'team_member' | 'workflow';
  id?: string;
  teamId?: string;
};
