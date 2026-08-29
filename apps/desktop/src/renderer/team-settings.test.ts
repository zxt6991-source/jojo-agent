import { describe, expect, it } from 'vitest';
import { createTeamDraft, teamInputFromDraft } from './TeamSettings';

describe('team settings draft', () => {
  it('builds a validated save input with member policies', () => {
    const draft = createTeamDraft('/workspace/project');
    draft.id = 'delivery_team';
    draft.name = 'Delivery Team';
    draft.members[0] = {
      ...draft.members[0]!,
      id: 'architect',
      name: 'Architect',
      profile: 'general',
      readOnly: true,
      toolsAllow: 'read_file, search, read_file',
      toolsDeny: 'shell',
      spawnEnabled: true,
      spawnProfiles: 'explore, code-review',
      spawnMaxActive: '2'
    };

    expect(teamInputFromDraft(draft, '/workspace/project')).toEqual({
      id: 'delivery_team',
      name: 'Delivery Team',
      workspace: '/workspace/project',
      maxConcurrency: 3,
      members: [{
        id: 'architect',
        name: 'Architect',
        profile: 'general',
        readOnly: true,
        tools: { allow: ['read_file', 'search'], deny: ['shell'] },
        spawn: { enabled: true, profiles: ['explore', 'code-review'], maxActive: 2 }
      }]
    });
  });

  it('rejects duplicate member ids before saving', () => {
    const draft = createTeamDraft('/workspace/project');
    draft.members.push({ ...draft.members[0]!, name: 'Second member' });
    expect(() => teamInputFromDraft(draft, '/workspace/project')).toThrow('成员 ID 重复');
  });
});
