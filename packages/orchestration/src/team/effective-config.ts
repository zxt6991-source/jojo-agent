import type { TeamMemberSnapshot } from '@desktop-agent/contracts';
import type { AgentProfileDefinition } from '../subagent/profile-registry.js';

export type EffectiveAgentConfig = {
  profile: AgentProfileDefinition;
  providerId: string;
  model: string;
  readOnly: boolean;
  systemPrompt: string;
  maxIterations: number;
  timeoutMs: number;
};

export function resolveEffectiveAgentConfig(input: {
  profile: AgentProfileDefinition;
  member: TeamMemberSnapshot;
  providerId?: string;
  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
}): EffectiveAgentConfig {
  const providerId = input.member.providerId ?? input.providerId;
  const inheritedModel = input.profile.model && input.profile.model !== 'inherit' ? input.profile.model : input.model;
  const model = input.member.model ?? inheritedModel;
  if (!providerId) throw new Error(`team_provider_required: ${input.member.id}`);
  if (!model) throw new Error(`team_model_required: ${input.member.id}`);
  return {
    profile: input.profile,
    providerId,
    model,
    readOnly: input.profile.readOnly || input.member.readOnly === true,
    systemPrompt: input.member.systemPrompt ?? '',
    maxIterations: input.maxIterations ?? input.profile.maxIterations ?? 8,
    timeoutMs: input.timeoutMs ?? input.profile.timeoutMs ?? 120_000
  };
}
