import type { RuntimePermissionGate, RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { ApprovalRequest, PermissionDecision, ToolCall } from '@desktop-agent/contracts';
import { NoopPermissionAuditSink } from './audit/audit.js';
import { PermissionGovernanceEngine } from './engine.js';
import { DefaultPermissionRequestNormalizer } from './normalization/normalizer.js';
import type {
  GovernanceDecision,
  GovernanceRequest,
  PermissionAuditSink,
  PermissionRequestNormalizer
} from './types.js';

function approvalSource(decision: GovernanceDecision): NonNullable<ApprovalRequest['governance']>['source'] {
  if (decision.source === 'mandatory_approval' || decision.source === 'user_policy' || decision.source === 'mode') return decision.source;
  return 'baseline';
}

export function toPermissionDecision(request: GovernanceRequest, decision: GovernanceDecision): PermissionDecision {
  if (decision.effect === 'allow') return { decision: 'allow' };
  if (decision.effect === 'deny') {
    return {
      decision: 'deny',
      reason: decision.reason,
      ...(request.baseline.decision === 'deny' && request.baseline.code ? { code: request.baseline.code } : {})
    };
  }
  const baselineRequest = request.baseline.decision === 'ask'
    ? request.baseline.request
    : {
        requestId: crypto.randomUUID(),
        sessionId: request.context.sessionId,
        call: request.call,
        reason: decision.reason
      };
  return {
    decision: 'ask',
    request: {
      ...baselineRequest,
      reason: decision.reason,
      governance: {
        decisionId: decision.id,
        requestFingerprint: request.fingerprint,
        source: approvalSource(decision),
        reasonCode: decision.reasonCode,
        risk: request.facts.risk,
        locked: decision.locked,
        ...(decision.policyRuleId ? { policyRuleId: decision.policyRuleId } : {})
      },
      grant: decision.locked
        ? { kind: 'approval', key: request.fingerprint, options: ['once'] }
        : { kind: 'approval', key: request.fingerprint, options: ['once', 'similar', 'conversation'] }
    }
  };
}

export class GovernanceRuntimePermissionGate implements RuntimePermissionGate {
  constructor(
    private readonly baseline: RuntimePermissionGate,
    private readonly engine = new PermissionGovernanceEngine(),
    private readonly normalizer: PermissionRequestNormalizer = new DefaultPermissionRequestNormalizer(),
    private readonly audit: PermissionAuditSink = new NoopPermissionAuditSink(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async check(call: ToolCall, context: RuntimeResolutionContext): Promise<PermissionDecision> {
    const baseline = await this.baseline.check(call, context);
    const request = await this.normalizer.normalize({ call, context, baseline });
    const decision = await this.engine.evaluate(request);
    await this.audit.record({ request, decision, createdAt: this.now().toISOString() });
    return toPermissionDecision(request, decision);
  }
}
