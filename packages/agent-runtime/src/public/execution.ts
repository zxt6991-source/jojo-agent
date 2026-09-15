import type { ContextBlock, ProjectIdentity, SubAgentMemoryBinding, WorkflowMemoryBinding, TeamMemberMemoryBinding } from '@desktop-agent/contracts';
import type { ExecutionScope } from '@desktop-agent/contracts/runtime';
import type { RunBudget, RuntimeActor, RuntimeTriggerContext, RuntimeWorkflowContext, RuntimeTeamContext } from './run.js';

export type RuntimeProviderBinding = { providerId: string; model: string; configurationFingerprint: string };
export type ExecutionInstructionBlock = Pick<ContextBlock, 'id' | 'source' | 'content' | 'priority'> & {
  kind: 'instruction'; sourceFingerprint: string; contentHash: string;
};
export type OperationExecutionSnapshotV1 = {
  schemaVersion: 1;
  capturedAt: number;
  origin: 'public-runtime' | 'trusted-harness';
  executionScope: ExecutionScope;
  actor: RuntimeActor;
  trigger?: RuntimeTriggerContext;
  workflow?: RuntimeWorkflowContext;
  team?: RuntimeTeamContext;
  providerBinding: RuntimeProviderBinding;
  budget: Required<RunBudget>;
  instructions: { requested: string[]; contributed: ExecutionInstructionBlock[]; compositionVersion: 1; fingerprint: string };
  runContext: {
    executionPolicyFingerprint: string;
    projectIdentity?: ProjectIdentity;
    memoryBinding?: SubAgentMemoryBinding | WorkflowMemoryBinding | TeamMemberMemoryBinding;
  };
};
export type RuntimeExecutionSummary = Pick<OperationExecutionSnapshotV1,
  'schemaVersion' | 'executionScope' | 'actor' | 'trigger' | 'workflow' | 'team' | 'providerBinding' | 'budget' | 'runContext'
> & { instructionFingerprint: string };
