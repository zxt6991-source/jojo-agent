import type { TeamMemberDefinition } from '@desktop-agent/contracts';
import type { TeamRolePresetId } from './presets';

export type AdvancedTeamMemberDraft = Pick<TeamMemberDefinition, 'profile' | 'providerId' | 'model' | 'systemPrompt' | 'tools' | 'spawn'>;
export type SimpleTeamMemberDraft = {
  id: string; name: string; responsibility: string; role: TeamRolePresetId;
  access: 'read' | 'write'; delegation: 'disabled' | 'auto'; modelMode: 'inherit' | 'custom';
  advanced: Partial<AdvancedTeamMemberDraft>;
  // Keep the exact persisted definition, including omitted and explicitly empty policies.
  original?: TeamMemberDefinition;
  enabled: boolean;
  autoPrompt: boolean;
};
export type TeamDraft = {
  id: string; name: string; description: string; maxConcurrency: string;
  concurrencyMode: 'auto' | 'custom'; members: SimpleTeamMemberDraft[];
};
