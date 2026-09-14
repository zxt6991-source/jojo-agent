import { TeamMemberDefinitionSchema, type DesktopApi, type TeamMemberDefinition, type TeamSnapshot } from '@desktop-agent/contracts';
import type { SimpleTeamMemberDraft, TeamDraft } from './draft';
import { ROLE_PRESETS, type TeamRolePresetId, type TeamTemplate } from './presets';
import { buildMemberSystemPrompt } from './prompt-builder';

export type SaveTeamInput = Parameters<DesktopApi['saveTeam']>[0];
export function createMemberDraft(existingIds: string[] = [], role: TeamRolePresetId = 'custom'): SimpleTeamMemberDraft {
  let index = 1;
  while (existingIds.includes(`member_${String(index).padStart(2, '0')}`)) index++;
  const preset = ROLE_PRESETS[role];
  return { id: `member_${String(index).padStart(2, '0')}`, name: preset.title, responsibility: preset.description, role, access: preset.defaultReadOnly ? 'read' : 'write', delegation: preset.defaultDelegation ? 'auto' : 'disabled', modelMode: 'inherit', advanced: {}, enabled: true, autoPrompt: true };
}
export function resolveProfile(draft: SimpleTeamMemberDraft) { return draft.advanced.profile ?? ROLE_PRESETS[draft.role].defaultProfile; }
export function effectiveReadOnly(draft: SimpleTeamMemberDraft): boolean {
  return ['explore', 'code-review', 'synthesize'].includes(resolveProfile(draft)) || draft.access === 'read';
}
export function changeMemberRole(draft: SimpleTeamMemberDraft, role: TeamRolePresetId): SimpleTeamMemberDraft {
  const preset = ROLE_PRESETS[role];
  return { ...draft, role, access: preset.defaultReadOnly ? 'read' : 'write', delegation: preset.defaultDelegation ? 'auto' : 'disabled', advanced: { ...draft.advanced, profile: preset.defaultProfile, spawn: undefined } };
}
export function memberFromDefinition(member: TeamMemberDefinition, enabled = true): SimpleTeamMemberDraft {
  const original = TeamMemberDefinitionSchema.parse(member);
  const role = (Object.keys(ROLE_PRESETS) as TeamRolePresetId[]).find((key) => key !== 'custom' && ROLE_PRESETS[key].defaultProfile === member.profile) ?? 'custom';
  return { id: member.id, name: member.name, responsibility: member.description ?? '', role,
    access: member.readOnly === true || ['explore', 'code-review', 'synthesize'].includes(member.profile) ? 'read' : 'write',
    delegation: member.spawn?.enabled ? 'auto' : 'disabled', modelMode: member.providerId !== undefined || member.model !== undefined ? 'custom' : 'inherit',
    advanced: { profile: member.profile, providerId: member.providerId, model: member.model, systemPrompt: member.systemPrompt, tools: member.tools, spawn: member.spawn }, original, enabled, autoPrompt: member.systemPrompt === buildMemberSystemPrompt({ name: member.name, responsibility: member.description ?? '', role, access: member.readOnly === true || ['explore', 'code-review', 'synthesize'].includes(member.profile) ? 'read' : 'write' }) };
}
export function buildTeamMemberDefinition(draft: SimpleTeamMemberDraft): TeamMemberDefinition {
  const base = draft.original;
  const originalDraft = base ? memberFromDefinition(base) : undefined;
  const same = <K extends keyof SimpleTeamMemberDraft>(key: K) => originalDraft?.[key] === draft[key];
  const profile = resolveProfile(draft);
  const spawn = draft.advanced.spawn ?? (draft.delegation === 'auto'
    ? { enabled: true, profiles: ROLE_PRESETS[draft.role].spawnProfiles, maxActive: 2 } : undefined);
  const result: TeamMemberDefinition = {
    id: draft.id, name: draft.name, profile,
    ...(base ?? {}),
  };
  result.id = draft.id;
  result.name = draft.name.trim();
  result.profile = profile;
  if (!same('responsibility')) result.description = draft.responsibility.trim() || undefined;
  if (!same('access')) result.readOnly = draft.access === 'read';
  if (draft.autoPrompt) result.systemPrompt = buildMemberSystemPrompt({ ...draft, access: effectiveReadOnly(draft) ? 'read' : 'write' });
  else if (draft.advanced.systemPrompt !== undefined) result.systemPrompt = draft.advanced.systemPrompt;
  else if (!base || base.systemPrompt !== undefined || !same('name') || !same('responsibility') || !same('role') || !same('access')) {
    result.systemPrompt = buildMemberSystemPrompt({ ...draft, access: effectiveReadOnly(draft) ? 'read' : 'write' });
  }
  result.tools = draft.advanced.tools;
  if (draft.modelMode === 'inherit') { delete result.providerId; delete result.model; }
  else { result.providerId = draft.advanced.providerId?.trim() || undefined; result.model = draft.advanced.model?.trim() || undefined; }
  result.spawn = draft.delegation === 'disabled'
    ? (same('delegation') ? base?.spawn : undefined)
    : spawn;
  const parsed = TeamMemberDefinitionSchema.safeParse(result);
  if (!parsed.success) throw new Error(`成员“${draft.name}”配置无效：${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`);
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as TeamMemberDefinition;
}
export function createTeamDraft(_workspace: string, team?: TeamSnapshot): TeamDraft {
  if (team) return { id: team.id, name: team.name, description: team.description ?? '', maxConcurrency: String(team.maxConcurrency), concurrencyMode: 'custom', members: team.members.map(({ laneId: _laneId, state, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...definition }) => memberFromDefinition(definition, state !== 'disabled')) };
  return { id: `team_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, name: '新团队', description: '', maxConcurrency: '3', concurrencyMode: 'auto', members: [createMemberDraft()] };
}
export function applyTeamTemplate(draft: TeamDraft, template: TeamTemplate): TeamDraft {
  const members: SimpleTeamMemberDraft[] = [];
  for (const member of template.members) members.push({ ...createMemberDraft(members.map((item) => item.id), member.role), name: member.name, responsibility: member.responsibility ?? ROLE_PRESETS[member.role].description });
  return { ...draft, name: template.title, description: template.description, members };
}
export function teamConcurrency(draft: TeamDraft): number {
  return draft.concurrencyMode === 'auto' ? Math.max(1, Math.min(draft.members.filter((member) => member.enabled).length, 3)) : Number(draft.maxConcurrency);
}
export function teamInputFromDraft(draft: TeamDraft, workspace: string, revision?: number): SaveTeamInput {
  if (!/^[a-z][a-z0-9_-]*$/u.test(draft.id)) throw new Error('团队 ID 格式无效。');
  if (!draft.name.trim()) throw new Error('请输入团队名称。');
  if (!workspace.trim()) throw new Error('请先打开一个项目，再配置团队。');
  if (draft.members.length < 1 || draft.members.length > 32) throw new Error('团队需要 1 到 32 名成员。');
  const maxConcurrency = teamConcurrency(draft);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) throw new Error('团队并发数必须是 1 到 16 的整数。');
  const members = draft.members.map(buildTeamMemberDefinition);
  if (new Set(members.map((member) => member.id)).size !== members.length) throw new Error('成员 ID 重复。');
  return { id: draft.id, name: draft.name.trim(), workspace: workspace.trim(), members, maxConcurrency,
    ...(draft.description ? { description: draft.description } : {}), ...(revision !== undefined ? { expectedRevision: revision } : {}) };
}
