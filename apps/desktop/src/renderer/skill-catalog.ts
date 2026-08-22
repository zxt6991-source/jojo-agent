import type { SkillStatus } from '@desktop-agent/contracts';

export function filterVisibleSkills(skills: SkillStatus[], search = ''): SkillStatus[] {
  const query = search.trim().toLowerCase();
  return skills.filter((skill) => {
    if (skill.overriddenBy) return false;
    return !query || `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query);
  });
}
