import type { PermissionDecisionAuditItem } from '@desktop-agent/contracts';

export const permissionModes = {
  ask: { title: '每次确认', description: '修改文件、运行命令等敏感操作通常先询问。' },
  auto: { title: '智能自动', description: '项目内明确低风险的操作自动执行，其余先询问。' },
  yolo: { title: '尽量自动', description: '普通审批自动通过；系统保护操作仍会询问或阻止。' }
} as const;
export const effectLabels = { allow: '自动执行', ask: '每次询问', deny: '阻止' } as const;
export const decisionLabels = { allow: '已允许', ask: '需要确认', deny: '已阻止' } as const;
export const riskLabels = { low: '低风险', medium: '中等风险', high: '高风险', critical: '极高风险' } as const;
const reasons: Record<string, string> = {
  auto_low_risk: '这个操作满足“智能自动”的低风险条件。',
  auto_not_eligible: '这个操作不满足智能自动的条件，需要你确认。',
  yolo_ordinary_approval: '“尽量自动”允许了这次普通操作。',
  workspace_boundary: '该操作尝试写入当前项目之外的位置。',
  outside_workspace_requires_confirmation: '访问当前项目之外的文件需要你的确认。',
  network_and_secret_requires_confirmation: '该命令同时申请主机网络访问和密钥使用，需要你的确认。',
  skill_install_requires_confirmation: '安装技能会改变 Jojo 可使用的能力，需要你的确认。',
  project_hook_trust_requires_confirmation: '项目钩子可以执行项目提供的自动化逻辑，信任前需要确认。',
  critical_terminal_weak_sandbox: '该命令风险极高且隔离保护不足，需要你的确认。',
  policy_allow: '你设置的例外规则允许了这次操作。',
  policy_ask: '你设置的例外规则要求先询问你。',
  policy_deny: '你设置的阻止规则禁止了这次操作。',
  session_grant: '本次对话中已有匹配的授权。',
  baseline_allow: '基础权限检查允许了这次操作。',
  baseline_ask: '基础权限检查要求你先确认这次操作。',
  baseline_deny: '基础安全检查阻止了这次操作。'
};
const sources: Record<PermissionDecisionAuditItem['source'], string> = {
  security_boundary: '系统安全边界', hard_floor: '系统保护', mandatory_approval: '必须确认的系统保护',
  user_policy: '你设置的例外规则', session_grant: '本次对话中的授权', mode: '当前确认策略', baseline: '基础权限检查'
};
export function decisionReason(item: PermissionDecisionAuditItem): string {
  return reasons[item.reasonCode] ?? `这次判断来自${sources[item.source]}，可展开技术详情查看具体原因。`;
}
