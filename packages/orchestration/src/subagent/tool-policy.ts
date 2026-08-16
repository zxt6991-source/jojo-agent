import type { AgentToolPolicy } from '@desktop-agent/contracts';
import type { AgentProfileDefinition } from './profile-registry.js';

export type { AgentToolPolicy } from '@desktop-agent/contracts';

export type EffectiveAgentToolPolicy = {
  readOnly: boolean;
  allowedTools: string[];
};

export const WRITE_CAPABLE_AGENT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'terminal']);

export function resolveAgentToolPolicy(
  availableTools: string[],
  profile: AgentProfileDefinition,
  request: { tools?: AgentToolPolicy; readOnly?: boolean } = {}
): EffectiveAgentToolPolicy {
  let allowed = new Set(availableTools);
  if (profile.allowedTools) {
    const profileAllow = new Set(profile.allowedTools);
    allowed = new Set([...allowed].filter((name) => profileAllow.has(name)));
  }
  if (request.tools?.allow) {
    const requestAllow = new Set(request.tools.allow);
    allowed = new Set([...allowed].filter((name) => requestAllow.has(name)));
  }
  const denied = new Set([...(profile.deniedTools ?? []), ...(request.tools?.deny ?? [])]);
  for (const name of denied) allowed.delete(name);
  const readOnly = profile.readOnly || request.readOnly === true;
  if (readOnly) for (const name of WRITE_CAPABLE_AGENT_TOOLS) allowed.delete(name);
  return { readOnly, allowedTools: [...allowed].sort() };
}
