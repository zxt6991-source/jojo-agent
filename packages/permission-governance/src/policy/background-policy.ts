import type {
  GovernanceContext,
  PermissionPolicyStore,
  PermissionRule,
  ResolvedPermissionPolicy
} from '../types.js';

/**
 * Narrow defaults for unattended agent lanes. User rules are resolved first, so
 * an explicit workspace/global ASK or DENY can always tighten these defaults.
 */
export const BACKGROUND_AGENT_PERMISSION_RULES: PermissionRule[] = [
  {
    id: 'builtin-background-workspace-write',
    effect: 'allow',
    match: {
      actors: ['subagent', 'workflow'],
      operations: ['write'],
      resourceScope: 'workspace'
    }
  },
  {
    id: 'builtin-background-isolated-terminal',
    effect: 'allow',
    match: {
      actors: ['subagent', 'workflow'],
      tools: ['terminal'],
      risks: ['medium'],
      network: 'none',
      hasSecrets: false,
      resourceScope: 'workspace'
    }
  }
];

export class BackgroundAgentPermissionPolicyStore implements PermissionPolicyStore {
  constructor(
    private readonly inner: PermissionPolicyStore,
    private readonly rules: PermissionRule[] = BACKGROUND_AGENT_PERMISSION_RULES
  ) {}

  async resolve(context: GovernanceContext): Promise<ResolvedPermissionPolicy> {
    const policy = await this.inner.resolve(context);
    return {
      ...policy,
      // Keep persisted user rules first: first-match ASK/ALLOW stays user-controlled,
      // while DENY remains dominant across every policy layer.
      globalRules: [...policy.globalRules, ...this.rules]
    };
  }
}
