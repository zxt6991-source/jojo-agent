import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type {
  ExecutionScope,
  PermissionDecision,
  PermissionPolicyDocumentContract,
  PermissionRuleContract,
  ToolCall
} from '@desktop-agent/contracts';

export type PermissionMode = 'ask' | 'auto' | 'yolo';
export type GovernanceRisk = 'low' | 'medium' | 'high' | 'critical';
export type ToolSource = 'native' | 'mcp' | 'browser' | 'memory' | 'orchestration' | 'skill' | 'hook';
export type OperationKind = 'read' | 'write' | 'execute' | 'network' | 'external_effect' | 'install' | 'trust' | 'control';
export type GovernanceEffect = 'allow' | 'ask' | 'deny';

export interface GovernanceContext {
  sessionId: string;
  laneId: string;
  runId: string;
  actor: { kind: 'main' | 'subagent' | 'workflow' | 'team_member'; id?: string; profile?: string };
  trigger: { kind: 'user' | 'api' | 'workflow' | 'subagent' | 'team_member' | 'scheduler' | 'resume' };
  team?: { id: string; memberId: string; taskId?: string };
  workingDirectory: string;
  executionScope: ExecutionScope;
  interactive: boolean;
}

export interface GovernanceFacts {
  source: ToolSource;
  operations: OperationKind[];
  risk: GovernanceRisk;
  capabilities: string[];
  resourceScope: 'workspace' | 'outside_workspace' | 'external' | 'none';
  terminal?: {
    executable: string;
    subcommand?: string;
    network: 'none' | 'host';
    secretEnv: string[];
    sandbox: 'strong' | 'container' | 'soft' | 'none';
  };
  mcp?: {
    serverId: string;
    serverFingerprint?: string;
    toolName: string;
    risk: 'read' | 'external_side_effect';
  };
  browser?: { origin?: string; externalEffect: boolean };
}

export interface GovernanceRequest {
  id: string;
  call: ToolCall;
  context: GovernanceContext;
  baseline: PermissionDecision;
  facts: GovernanceFacts;
  fingerprint: string;
  grantClass: string;
}

export type GovernanceDecisionSource =
  | 'security_boundary'
  | 'hard_floor'
  | 'mandatory_approval'
  | 'user_policy'
  | 'session_grant'
  | 'mode'
  | 'baseline';

export interface GovernanceDecision {
  id: string;
  effect: GovernanceEffect;
  locked: boolean;
  source: GovernanceDecisionSource;
  reasonCode: string;
  reason: string;
  policyRuleId?: string;
  requestFingerprint: string;
  grantKey?: string;
}

export type PermissionRule = PermissionRuleContract;
export type PermissionPolicyDocument = PermissionPolicyDocumentContract;

export type ResolvedPermissionPolicy = {
  mode: PermissionMode;
  globalRules: PermissionRule[];
  workspaceRules: PermissionRule[];
  revision?: number;
};

export interface PermissionPolicyStore {
  resolve(context: GovernanceContext): ResolvedPermissionPolicy | Promise<ResolvedPermissionPolicy>;
}

export type GrantScope = 'once' | 'similar' | 'conversation';
export type PermissionGrant = { key: string; scope: Exclude<GrantScope, 'once'> };

export interface PermissionGrantStore {
  find(request: GovernanceRequest): PermissionGrant | undefined;
  remember(request: GovernanceRequest): void;
  grant(request: GovernanceRequest, scope: GrantScope): void;
  grantApproval(sessionId: string, requestFingerprint: string, scope: GrantScope): boolean;
  clearSession(sessionId: string): void;
}

export type PermissionAuditRecord = {
  request: GovernanceRequest;
  decision: GovernanceDecision;
  createdAt: string;
};

export interface PermissionAuditSink {
  record(record: PermissionAuditRecord): void | Promise<void>;
}

export interface PermissionRequestNormalizer {
  normalize(input: {
    call: ToolCall;
    context: RuntimeResolutionContext;
    baseline: PermissionDecision;
  }): GovernanceRequest | Promise<GovernanceRequest>;
}

export interface HardFloorEvaluator {
  evaluate(request: GovernanceRequest): { reasonCode: string; reason: string } | undefined;
}

export interface MandatoryApprovalEvaluator {
  evaluate(request: GovernanceRequest): { reasonCode: string; reason: string } | undefined;
}
