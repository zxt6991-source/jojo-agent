import type { GovernanceDecision, GovernanceRequest, PermissionMode } from '../types.js';

export class AutoPermissionPolicy {
  isEligible(request: GovernanceRequest): boolean {
    const { facts } = request;
    if (facts.resourceScope === 'outside_workspace') return false;
    if (facts.terminal) {
      return facts.terminal.network === 'none'
        && facts.terminal.secretEnv.length === 0
        && (facts.terminal.sandbox === 'strong' || facts.terminal.sandbox === 'container')
        && facts.risk === 'medium';
    }
    if (facts.operations.includes('external_effect')) return false;
    return facts.operations.includes('write') && facts.resourceScope === 'workspace';
  }
}

export class PermissionModeEvaluator {
  constructor(private readonly autoPolicy = new AutoPermissionPolicy()) {}

  evaluate(request: GovernanceRequest, mode: PermissionMode): Omit<GovernanceDecision, 'id' | 'requestFingerprint'> {
    if (request.baseline.decision !== 'ask') {
      return {
        effect: request.baseline.decision,
        locked: false,
        source: 'baseline',
        reasonCode: `baseline_${request.baseline.decision}`,
        reason: request.baseline.decision === 'deny' ? request.baseline.reason : 'Allowed by the baseline permission gate.'
      };
    }
    if (mode === 'yolo') {
      return { effect: 'allow', locked: false, source: 'mode', reasonCode: 'yolo_ordinary_approval', reason: 'YOLO mode approved an ordinary confirmation.' };
    }
    if (mode === 'auto' && this.autoPolicy.isEligible(request)) {
      return { effect: 'allow', locked: false, source: 'mode', reasonCode: 'auto_low_risk', reason: 'AUTO mode approved a deterministic low-risk operation.' };
    }
    return { effect: 'ask', locked: false, source: mode === 'ask' ? 'baseline' : 'mode', reasonCode: mode === 'ask' ? 'baseline_ask' : 'auto_not_eligible', reason: request.baseline.request.reason };
  }
}
