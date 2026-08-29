import type {
  AgentEvent,
  HookRuntime,
  SubAgentMemoryBinding,
  SubAgentProfile,
  TeamMemberMemoryBinding,
  UsageTotals,
  WorkflowMemoryBinding
} from '@desktop-agent/contracts';
import type { AgentToolPolicy } from '../subagent/tool-policy.js';

export type OrchestratedActor =
  | { kind: 'subagent'; id: string; profile: string }
  | { kind: 'team_member'; id: string; profile: string; teamId: string; memberId: string; taskId?: string }
  | { kind: 'workflow'; id: string; profile: string; workflowId: string; stepId?: string };

export type OrchestratedAgentRunRequest = {
  id: string;
  sessionId: string;
  laneId: string;
  parentLaneId?: string;
  workingDirectory: string;
  task: string;
  actor: OrchestratedActor;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  maxIterations: number;
  timeoutMs: number;
  tools?: AgentToolPolicy;
  readOnly?: boolean;
  outputSchema?: Record<string, unknown>;
  memoryBinding?: SubAgentMemoryBinding | WorkflowMemoryBinding | TeamMemberMemoryBinding;
  hooks?: HookRuntime;
  additionalInstructions?: string[];
};

export type OrchestratedAgentRunResult = {
  result: string;
  stopReason: string;
  model?: string;
  usage: UsageTotals;
  incomplete: boolean;
  runId?: string;
};

export interface OrchestratedAgentRunner {
  run(
    request: OrchestratedAgentRunRequest,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<OrchestratedAgentRunResult>;
}
