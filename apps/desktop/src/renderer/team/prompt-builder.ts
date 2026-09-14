import { ROLE_PRESETS, type TeamRolePresetId } from './presets';

const ROLE_REQUIREMENTS: Record<TeamRolePresetId, string> = {
  analysis: '先阅读相关实现并核实假设；给出依据、影响范围与分步骤方案。',
  development: '遵循项目约定，以必要的改动实现职责；运行相关验证并报告结果与未验证项。',
  review: '优先报告可复现的问题、风险和测试缺口；注明位置、影响与建议，区分事实和推测。',
  synthesis: '综合各方证据，标出冲突与未知信息；输出结论、取舍理由和下一步。',
  custom: '明确任务范围，核实关键假设，交付可验证的结果。'
};
export function buildMemberSystemPrompt(input: { name: string; responsibility: string; role: TeamRolePresetId; access: 'read' | 'write' }): string {
  return `你是当前项目的${input.name}，承担${ROLE_PRESETS[input.role].title}职责。\n\n职责：\n${input.responsibility || ROLE_PRESETS[input.role].description}\n\n工作要求：\n- 聚焦当前项目，不执行职责之外的任务。\n- ${ROLE_REQUIREMENTS[input.role]}\n- 给出明确、可执行的结论，不虚构执行或验证结果。\n- ${input.access === 'read' ? '只能阅读、搜索和分析，不修改项目文件。' : '可以修改项目文件，遵守项目权限和审批边界。'}\n- 遵守成员权限边界；分派任务时说明目标并核实助手结果。`;
}
