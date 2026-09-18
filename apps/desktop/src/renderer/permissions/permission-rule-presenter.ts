import type { PermissionRuleContract } from '@desktop-agent/contracts';
const labels: Record<string, string> = {
  main: '主智能体', subagent: '子智能体', workflow: '工作流', team_member: '团队成员', channel_user: '渠道用户',
  user: '用户', api: '接口调用', scheduler: '定时任务', resume: '恢复执行', channel_message: '渠道消息',
  native: '内置工具', mcp: 'MCP', browser: '浏览器', memory: '记忆', orchestration: '智能体协作', skill: '技能', hook: '项目钩子', channel: '消息渠道',
  read: '读取', write: '修改', execute: '运行命令', network: '联网', external_effect: '外部副作用', install: '安装', trust: '信任', control: '控制',
  low: '低风险', medium: '中等风险', high: '高风险', critical: '极高风险',
  workspace: '当前项目内', outside_workspace: '当前项目外', external: '外部资源', none: '无资源'
};
const fieldLabels = { actors: '执行者', triggers: '触发方式', sources: '工具来源', tools: '具体工具', operations: '操作', risks: '风险' };
export function presentRule(rule: PermissionRuleContract): string {
  const parts: string[] = [];
  for (const key of Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]) {
    const values = rule.match[key];
    if (values) parts.push(`${fieldLabels[key]}：${values.length ? values.map((value) => labels[value] ?? value).join(key === 'operations' ? '且' : '或') : key === 'operations' ? '不限' : '无匹配值'}`);
  }
  if (rule.match.network) parts.push(rule.match.network === 'host' ? '使用主机网络' : '不使用网络');
  if (rule.match.hasSecrets !== undefined) parts.push(rule.match.hasSecrets ? '使用密钥' : '不使用密钥');
  if (rule.match.resourceScope) parts.push(`资源范围：${labels[rule.match.resourceScope]}`);
  return parts.join('；') || '所有操作（未限定条件）';
}
