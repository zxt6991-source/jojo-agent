import type { SubAgentProfile } from '@desktop-agent/contracts';

export type TeamRolePresetId = 'analysis' | 'development' | 'review' | 'synthesis' | 'custom';
export type TeamRolePreset = {
  title: string; description: string; defaultProfile: SubAgentProfile;
  defaultReadOnly: boolean; defaultDelegation: boolean; spawnProfiles: SubAgentProfile[];
};
export const ROLE_PRESETS: Record<TeamRolePresetId, TeamRolePreset> = {
  analysis: { title: '分析', description: '理解需求、分析项目结构并制定可执行方案。', defaultProfile: 'explore', defaultReadOnly: true, defaultDelegation: true, spawnProfiles: ['explore', 'synthesize'] },
  development: { title: '开发', description: '实现功能、修改代码并修复问题，验证改动结果。', defaultProfile: 'general', defaultReadOnly: false, defaultDelegation: true, spawnProfiles: ['explore', 'code-review'] },
  review: { title: '代码审查', description: '检查改动中的 Bug、风险和缺失测试，提供定位依据。', defaultProfile: 'code-review', defaultReadOnly: true, defaultDelegation: false, spawnProfiles: ['explore'] },
  synthesis: { title: '汇总', description: '整理多个成员的结果，比较证据并形成明确结论。', defaultProfile: 'synthesize', defaultReadOnly: true, defaultDelegation: false, spawnProfiles: [] },
  custom: { title: '自定义', description: '负责当前项目中指定的工作。', defaultProfile: 'general', defaultReadOnly: true, defaultDelegation: false, spawnProfiles: ['explore'] }
};
export type TeamTemplate = { id: string; title: string; description: string; members: { name: string; role: TeamRolePresetId; responsibility?: string }[] };
export const TEAM_TEMPLATES: TeamTemplate[] = [
  { id: 'software-development', title: '软件开发团队', description: '从架构分析到功能实现与代码审查。', members: [{ name: '架构分析', role: 'analysis' }, { name: '开发', role: 'development' }, { name: '代码审查', role: 'review' }] },
  { id: 'code-review', title: '代码审查团队', description: '分析项目背景，检查质量与测试风险。', members: [{ name: '代码分析', role: 'analysis' }, { name: '代码审查', role: 'review' }] },
  { id: 'research', title: '研究分析团队', description: '多角度调研、比较方案并汇总结果。', members: [{ name: '资料调研', role: 'analysis', responsibility: '搜集相关资料，核实来源并记录证据与局限。' }, { name: '代码分析', role: 'analysis' }, { name: '方案比较', role: 'analysis', responsibility: '比较备选方案的可行性、成本和风险，给出建议。' }, { name: '结果汇总', role: 'synthesis' }] },
  { id: 'light-development', title: '轻量开发团队', description: '适合小功能和日常修复。', members: [{ name: '开发', role: 'development' }, { name: '代码审查', role: 'review' }] },
  { id: 'custom', title: '自定义团队', description: '从一名成员开始，自由定义职责。', members: [{ name: '项目助手', role: 'custom' }] }
];
