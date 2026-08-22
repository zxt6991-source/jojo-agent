import { describe, expect, it } from 'vitest';
import type { SkillStatus } from '@desktop-agent/contracts';
import { filterVisibleSkills } from './skill-catalog';

function skill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    id: 'lark-approval',
    name: 'lark-approval',
    description: '飞书审批',
    path: '/project/.agents/skills/lark-approval/SKILL.md',
    rootPath: '/project/.agents/skills/lark-approval',
    origin: 'project',
    resources: { scripts: [], templates: [], references: [] },
    enabled: true,
    ...overrides
  };
}

describe('skill catalog visibility', () => {
  it('hides overridden skills from the catalog and search results', () => {
    const winner = skill();
    const overridden = skill({
      path: '/user/.codex/skills/lark-approval/SKILL.md',
      rootPath: '/user/.codex/skills/lark-approval',
      origin: 'user',
      enabled: false,
      overriddenBy: winner.path
    });

    expect(filterVisibleSkills([overridden, winner])).toEqual([winner]);
    expect(filterVisibleSkills([overridden, winner], '/user/.codex')).toEqual([]);
  });

  it('keeps non-overridden skills visible even when discovery reports an error', () => {
    const invalid = skill({ id: 'invalid', name: 'invalid', error: '缺少 description', enabled: false });

    expect(filterVisibleSkills([invalid], 'INVALID')).toEqual([invalid]);
  });
});
