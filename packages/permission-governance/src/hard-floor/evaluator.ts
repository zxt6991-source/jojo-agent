import type { GovernanceRequest, HardFloorEvaluator, MandatoryApprovalEvaluator } from '../types.js';

export class DefaultHardFloorEvaluator implements HardFloorEvaluator {
  evaluate(request: GovernanceRequest): { reasonCode: string; reason: string } | undefined {
    if (request.facts.resourceScope === 'outside_workspace' && request.facts.operations.includes('write')) {
      return {
        reasonCode: 'workspace_boundary',
        reason: 'Writing outside the workspace is prohibited by the security boundary.'
      };
    }
    return undefined;
  }
}

export class DefaultMandatoryApprovalEvaluator implements MandatoryApprovalEvaluator {
  evaluate(request: GovernanceRequest): { reasonCode: string; reason: string } | undefined {
    if (request.facts.resourceScope === 'outside_workspace') {
      return { reasonCode: 'outside_workspace_requires_confirmation', reason: 'Access outside the workspace requires confirmation.' };
    }
    if (request.call.name === 'install_skill') {
      return { reasonCode: 'skill_install_requires_confirmation', reason: 'Installing a Skill always requires confirmation.' };
    }
    if (request.call.name === 'trust_project_hooks') {
      return { reasonCode: 'project_hook_trust_requires_confirmation', reason: 'Trusting project Hooks always requires confirmation.' };
    }
    const terminal = request.facts.terminal;
    if (terminal && request.facts.risk === 'critical' && (terminal.sandbox === 'soft' || terminal.sandbox === 'none')) {
      return { reasonCode: 'critical_terminal_weak_sandbox', reason: 'A critical command with a weak sandbox requires confirmation.' };
    }
    if (terminal && terminal.network === 'host' && terminal.secretEnv.length > 0) {
      return { reasonCode: 'network_and_secret_requires_confirmation', reason: 'Host network access combined with secrets requires confirmation.' };
    }
    return undefined;
  }
}
