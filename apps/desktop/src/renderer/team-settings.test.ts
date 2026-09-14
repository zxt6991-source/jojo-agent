import { describe, expect, it } from 'vitest';
import type { TeamMemberDefinition, TeamSnapshot } from '@desktop-agent/contracts';
import { applyTeamTemplate, buildTeamMemberDefinition, changeMemberRole, createMemberDraft, createTeamDraft, effectiveReadOnly, memberFromDefinition, teamInputFromDraft } from './team/mappings';
import { TEAM_TEMPLATES } from './team/presets';
import { buildMemberSystemPrompt } from './team/prompt-builder';

describe('team settings semantic mapping', () => {
  it.each([['analysis', 'explore', true], ['development', 'general', false], ['review', 'code-review', true], ['synthesis', 'synthesize', true]] as const)('maps %s role with safe defaults', (role, profile, readOnly) => {
    const draft = createMemberDraft([], role);
    const member = buildTeamMemberDefinition(draft);
    expect(member).toMatchObject({ profile, readOnly });
    expect(member.tools).toBeUndefined();
    expect(member.providerId).toBeUndefined();
    expect(member.model).toBeUndefined();
    expect(member.systemPrompt).toContain(draft.responsibility);
    if (draft.delegation === 'auto') expect(member.spawn).toEqual({ enabled: true, profiles: role === 'analysis' ? ['explore', 'synthesize'] : ['explore', 'code-review'], maxActive: 2 });
    else expect(member.spawn).toBeUndefined();
  });
  it.each(TEAM_TEMPLATES)('creates runnable $title without technical input', (template) => {
    const draft = applyTeamTemplate(createTeamDraft('/project'), template);
    const input = teamInputFromDraft(draft, '/project');
    expect(input.members).toHaveLength(template.members.length);
    expect(input.maxConcurrency).toBe(Math.min(template.members.length, 3));
    expect(input.id).toMatch(/^team_[a-z0-9]+$/);
  });
  it('does not weaken read-only profile constraints when access says write', () => {
    const draft = createMemberDraft([], 'analysis');
    draft.access = 'write';
    expect(effectiveReadOnly(draft)).toBe(true);
    expect(buildTeamMemberDefinition(draft).systemPrompt).toContain('不修改项目文件');
    const developer = changeMemberRole(draft, 'development');
    expect(effectiveReadOnly(developer)).toBe(false);
  });
  const legacyDefinitions: TeamMemberDefinition[] = [
    { id: 'minimal', name: 'Minimal', profile: 'general' },
    { id: 'custom', name: 'Custom', description: 'custom responsibility', profile: 'project-specialist', readOnly: false, systemPrompt: '', providerId: 'provider', model: 'model', tools: { allow: [], deny: [] }, spawn: { enabled: false, profiles: [], maxActive: 7 } },
    { id: 'reviewer', name: 'Reviewer', profile: 'code-review', readOnly: false, systemPrompt: 'Do not replace this prompt.', tools: {}, spawn: { enabled: true } },
    { id: 'analysis', name: 'Analysis', profile: 'explore', tools: { allow: ['read_file'], deny: ['shell'] }, spawn: { enabled: true, profiles: ['project-specialist'], maxActive: 5 }, model: 'custom-model' }
  ];
  it.each(legacyDefinitions)('round-trips legacy $id losslessly', (definition) => {
    const draft = memberFromDefinition(definition);
    expect(buildTeamMemberDefinition(draft)).toStrictEqual(definition);
    draft.name = 'Renamed';
    const saved = buildTeamMemberDefinition(draft);
    expect(saved.tools).toEqual(definition.tools);
    expect(saved.spawn).toEqual(definition.spawn);
    expect(saved.model).toEqual(definition.model);
    if (definition.systemPrompt !== undefined) expect(saved.systemPrompt).toBe(definition.systemPrompt);
  });
  it('clears overrides only when explicitly requested', () => {
    const draft = memberFromDefinition(legacyDefinitions[3]!);
    draft.modelMode = 'inherit'; draft.advanced.tools = undefined; draft.delegation = 'disabled';
    const saved = buildTeamMemberDefinition(draft);
    expect(saved.model).toBeUndefined(); expect(saved.providerId).toBeUndefined(); expect(saved.tools).toBeUndefined(); expect(saved.spawn).toBeUndefined();
  });
  it('preserves snapshots without leaking runtime metadata', () => {
    const definition = legacyDefinitions[1]!;
    const team = { id: 'team_old', name: 'Old', description: 'Saved', maxConcurrency: 6, revision: 4, members: [{ ...definition, laneId: 'lane', state: 'disabled', revision: 2, createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' }] } as TeamSnapshot;
    const draft = createTeamDraft('/project', team);
    const input = teamInputFromDraft(draft, '/project', team.revision);
    expect(input.members).toEqual([definition]); expect(input.maxConcurrency).toBe(6); expect(input.expectedRevision).toBe(4);
    draft.concurrencyMode = 'auto'; expect(teamInputFromDraft(draft, '/project').maxConcurrency).toBe(1);
  });
  it('regenerates automatic prompts after reloading and editing responsibilities', () => {
    const draft = memberFromDefinition(buildTeamMemberDefinition(createMemberDraft([], 'development')));
    draft.responsibility = '修复支付回调的重复处理问题';
    expect(buildTeamMemberDefinition(draft).systemPrompt).toContain(draft.responsibility);
  });
  it('generates role-specific evidence and validation instructions', () => {
    expect(buildMemberSystemPrompt({ name: 'Reviewer', responsibility: '检查支付模块', role: 'review', access: 'read' })).toContain('注明位置、影响与建议');
    expect(buildMemberSystemPrompt({ name: 'Developer', responsibility: '实现支付模块', role: 'development', access: 'write' })).toContain('运行相关验证');
  });
  it('rejects invalid limits, duplicate ids and bad custom profiles', () => {
    const draft = createTeamDraft('/project');
    draft.members.push({ ...draft.members[0]!, name: 'Duplicate' });
    expect(() => teamInputFromDraft(draft, '/project')).toThrow('成员 ID 重复');
    draft.members.pop(); draft.concurrencyMode = 'custom'; draft.maxConcurrency = '0';
    expect(() => teamInputFromDraft(draft, '/project')).toThrow('并发数');
    draft.members[0]!.advanced.profile = 'invalid profile';
    expect(() => buildTeamMemberDefinition(draft.members[0]!)).toThrow('配置无效');
  });
  it('avoids member ID reuse after deleting a middle member', () => {
    expect(createMemberDraft(['member_01', 'member_03']).id).toBe('member_02');
  });
});
