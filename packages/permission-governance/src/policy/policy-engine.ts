import type { GovernanceRequest, PermissionRule, ResolvedPermissionPolicy } from '../types.js';

export type MatchedPermissionRule = PermissionRule & { scope: 'workspace' | 'global' };

function includesAll<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return expected.every((value) => actual.includes(value));
}

export function ruleMatches(rule: PermissionRule, request: GovernanceRequest): boolean {
  const { match } = rule;
  if (match.actors && !match.actors.includes(request.context.actor.kind)) return false;
  if (match.triggers && !match.triggers.includes(request.context.trigger.kind)) return false;
  if (match.sources && !match.sources.includes(request.facts.source)) return false;
  if (match.tools && !match.tools.includes(request.call.name)) return false;
  if (match.operations && !includesAll(request.facts.operations, match.operations)) return false;
  if (match.risks && !match.risks.includes(request.facts.risk)) return false;
  if (match.network && request.facts.terminal?.network !== match.network) return false;
  if (match.hasSecrets !== undefined && ((request.facts.terminal?.secretEnv.length ?? 0) > 0) !== match.hasSecrets) return false;
  if (match.resourceScope && request.facts.resourceScope !== match.resourceScope) return false;
  return true;
}

export class PermissionPolicyEngine {
  match(request: GovernanceRequest, policy: ResolvedPermissionPolicy): MatchedPermissionRule | undefined {
    const workspace = policy.workspaceRules.filter((rule) => ruleMatches(rule, request));
    const global = policy.globalRules.filter((rule) => ruleMatches(rule, request));
    const all = [
      ...workspace.map((rule) => ({ ...rule, scope: 'workspace' as const })),
      ...global.map((rule) => ({ ...rule, scope: 'global' as const }))
    ];
    const deny = all.find((rule) => rule.effect === 'deny');
    if (deny) return deny;
    const workspaceRule = workspace[0];
    if (workspaceRule) return { ...workspaceRule, scope: 'workspace' };
    const globalRule = global[0];
    return globalRule ? { ...globalRule, scope: 'global' } : undefined;
  }
}

export class StaticPermissionPolicyStore {
  constructor(private readonly policy: ResolvedPermissionPolicy = {
    mode: 'ask', globalRules: [], workspaceRules: []
  }) {}

  resolve(): ResolvedPermissionPolicy { return this.policy; }
}
