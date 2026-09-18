import { PermissionRuleSchema, type PermissionRuleContract } from '@desktop-agent/contracts';

export const ruleTemplates = [
  { title: '项目内文件修改', effect: 'allow', match: { sources: ['native'], operations: ['write'], resourceScope: 'workspace' } },
  { title: '终端使用主机网络', effect: 'ask', match: { sources: ['native'], tools: ['terminal'], network: 'host' } },
  { title: '终端使用密钥', effect: 'ask', match: { sources: ['native'], tools: ['terminal'], hasSecrets: true } },
  { title: '定时任务使用密钥', effect: 'deny', match: { triggers: ['scheduler'], hasSecrets: true } },
  { title: '浏览器产生外部副作用', effect: 'ask', match: { sources: ['browser'], operations: ['external_effect'] } },
  { title: 'MCP 外部副作用', effect: 'ask', match: { sources: ['mcp'], operations: ['external_effect'] } },
  { title: '子智能体修改当前项目', effect: 'allow', match: { actors: ['subagent'], operations: ['write'], resourceScope: 'workspace' } },
  { title: '运行本地命令', effect: 'ask', match: { sources: ['native'], tools: ['terminal'] } },
  { title: '访问项目外文件', effect: 'ask', match: { resourceScope: 'outside_workspace' } }
] satisfies { title: string; effect: PermissionRuleContract['effect']; match: PermissionRuleContract['match'] }[];

export function buildRule(templateIndex: number, effect: PermissionRuleContract['effect'], id: string): PermissionRuleContract {
  const template = ruleTemplates[templateIndex];
  if (!template) throw new Error('请选择操作类型');
  return PermissionRuleSchema.parse({ id, effect, match: template.match });
}

// Only report provable coverage. Operations are AND; the other arrays are OR.
export function ruleCovers(broad: PermissionRuleContract, narrow: PermissionRuleContract): boolean {
  return Object.entries(broad.match).every(([key, value]) => {
    const other = narrow.match[key as keyof PermissionRuleContract['match']];
    if (Array.isArray(value)) {
      if (key === 'operations') return value.length === 0 || (Array.isArray(other) && value.every((entry) => other.includes(entry as never)));
      return value.length > 0 && Array.isArray(other) && other.length > 0 && other.every((entry) => (value as readonly unknown[]).includes(entry));
    }
    return other === value;
  });
}

export function ruleWarning(rule: PermissionRuleContract, index: number, rules: PermissionRuleContract[], globalRules: PermissionRuleContract[] = []): string | undefined {
  if (rule.effect === 'deny') return undefined;
  if ([...globalRules, ...rules].some((other) => other.effect === 'deny' && ruleCovers(other, rule))) {
    return '这条规则的范围已被阻止规则覆盖。阻止规则在所有项目和当前项目之间始终优先。';
  }
  if (rules.slice(0, index).some((other) => ruleCovers(other, rule))) {
    return '这条规则可能不会命中：前面的规则覆盖了相同或更广的范围。';
  }
  return undefined;
}
