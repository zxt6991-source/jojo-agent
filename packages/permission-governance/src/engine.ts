import { DefaultHardFloorEvaluator, DefaultMandatoryApprovalEvaluator } from './hard-floor/evaluator.js';
import { PermissionModeEvaluator } from './modes/mode-evaluator.js';
import { PermissionPolicyEngine, StaticPermissionPolicyStore } from './policy/policy-engine.js';
import type {
  GovernanceDecision,
  GovernanceDecisionSource,
  GovernanceRequest,
  HardFloorEvaluator,
  MandatoryApprovalEvaluator,
  PermissionGrantStore,
  PermissionPolicyStore
} from './types.js';

export type PermissionGovernanceEngineOptions = {
  policyStore?: PermissionPolicyStore;
  grantStore?: PermissionGrantStore;
  hardFloor?: HardFloorEvaluator;
  mandatoryApproval?: MandatoryApprovalEvaluator;
  policyEngine?: PermissionPolicyEngine;
  modeEvaluator?: PermissionModeEvaluator;
};

function decision(
  request: GovernanceRequest,
  effect: GovernanceDecision['effect'],
  source: GovernanceDecisionSource,
  reasonCode: string,
  reason: string,
  options: { locked?: boolean; policyRuleId?: string; grantKey?: string } = {}
): GovernanceDecision {
  return {
    id: crypto.randomUUID(), effect, source, reasonCode, reason,
    locked: options.locked ?? false,
    requestFingerprint: request.fingerprint,
    ...(options.policyRuleId ? { policyRuleId: options.policyRuleId } : {}),
    ...(options.grantKey ? { grantKey: options.grantKey } : {})
  };
}

export class PermissionGovernanceEngine {
  private readonly policyStore: PermissionPolicyStore;
  private readonly grantStore: PermissionGrantStore | undefined;
  private readonly hardFloor: HardFloorEvaluator;
  private readonly mandatoryApproval: MandatoryApprovalEvaluator;
  private readonly policyEngine: PermissionPolicyEngine;
  private readonly modeEvaluator: PermissionModeEvaluator;

  constructor(options: PermissionGovernanceEngineOptions = {}) {
    this.policyStore = options.policyStore ?? new StaticPermissionPolicyStore();
    this.grantStore = options.grantStore;
    this.hardFloor = options.hardFloor ?? new DefaultHardFloorEvaluator();
    this.mandatoryApproval = options.mandatoryApproval ?? new DefaultMandatoryApprovalEvaluator();
    this.policyEngine = options.policyEngine ?? new PermissionPolicyEngine();
    this.modeEvaluator = options.modeEvaluator ?? new PermissionModeEvaluator();
  }

  async evaluate(request: GovernanceRequest): Promise<GovernanceDecision> {
    if (request.baseline.decision === 'deny') {
      return decision(request, 'deny', 'security_boundary', request.baseline.code ?? 'security_boundary', request.baseline.reason, { locked: true });
    }
    const floor = this.hardFloor.evaluate(request);
    if (floor) return decision(request, 'deny', 'hard_floor', floor.reasonCode, floor.reason, { locked: true });

    const policy = await this.policyStore.resolve(request.context);
    const explicit = this.policyEngine.match(request, policy);
    if (explicit?.effect === 'deny') {
      return decision(request, 'deny', 'user_policy', 'policy_deny', `Denied by permission rule ${explicit.id}.`, { policyRuleId: explicit.id });
    }

    const mandatory = this.mandatoryApproval.evaluate(request);
    if (mandatory) {
      this.grantStore?.remember(request);
      return decision(request, 'ask', 'mandatory_approval', mandatory.reasonCode, mandatory.reason, { locked: true });
    }
    if (explicit?.effect === 'ask') {
      this.grantStore?.remember(request);
      return decision(request, 'ask', 'user_policy', 'policy_ask', `Confirmation required by permission rule ${explicit.id}.`, { policyRuleId: explicit.id });
    }

    if (request.baseline.decision === 'ask') {
      const grant = this.grantStore?.find(request);
      if (grant) return decision(request, 'allow', 'session_grant', 'session_grant', 'Allowed by a matching session grant.', { grantKey: grant.key });
    }
    if (explicit?.effect === 'allow') {
      return decision(request, 'allow', 'user_policy', 'policy_allow', `Allowed by permission rule ${explicit.id}.`, { policyRuleId: explicit.id });
    }

    const evaluated = this.modeEvaluator.evaluate(request, policy.mode);
    if (evaluated.effect === 'ask') this.grantStore?.remember(request);
    return {
      id: crypto.randomUUID(),
      requestFingerprint: request.fingerprint,
      ...evaluated
    };
  }
}
