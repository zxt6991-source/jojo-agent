import React, { useState } from 'react';
import { PermissionRuleSchema, type PermissionRuleContract } from '@desktop-agent/contracts';
import { buildRule, ruleTemplates } from './permission-rule-builder';
import { presentRule } from './permission-rule-presenter';
import { effectLabels } from './permission-copy';

export function PermissionRuleEditor({ rule, onApply, onCancel }: {
  rule?: PermissionRuleContract;
  onApply: (rule: PermissionRuleContract) => void;
  onCancel: () => void;
}) {
  const [template, setTemplate] = useState(0);
  const [effect, setEffect] = useState<PermissionRuleContract['effect']>(rule?.effect ?? 'allow');
  const [advanced, setAdvanced] = useState(false);
  const [matchJson, setMatchJson] = useState(JSON.stringify(rule?.match ?? ruleTemplates[0]!.match, null, 2));
  const [error, setError] = useState('');
  return <section className="permission-rule-form" aria-label={rule ? '编辑例外规则' : '添加例外规则'}>
    <h3>{rule ? '编辑例外规则' : '添加例外规则'}</h3>
    {!rule && <label>1. 你想控制哪类操作？<select value={template} onChange={(event) => {
      const index = Number(event.target.value); setTemplate(index); setEffect(ruleTemplates[index]!.effect);
      setMatchJson(JSON.stringify(ruleTemplates[index]!.match, null, 2)); setError('');
    }}>{ruleTemplates.map((item, index) => <option key={item.title} value={index}>{item.title}</option>)}</select></label>}
    {rule && <p>{presentRule(rule)}</p>}
    <label>{rule ? '遇到这种行为时' : '2. 遇到这种行为时'}<select value={effect} onChange={(event) => setEffect(event.target.value as PermissionRuleContract['effect'])}>
      {Object.entries(effectLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
    </select></label>
    <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>更多条件（高级）</summary>
      <label>匹配条件 JSON<textarea aria-label="规则匹配条件 JSON" value={matchJson} onChange={(event) => setMatchJson(event.target.value)} spellCheck={false}/></label>
      <p>支持执行者、触发方式、工具来源、工具、操作、风险、网络、密钥和资源范围；未设置的条件表示不限。</p>
    </details>
    {effect === 'allow' && <p>自动执行仍受系统保护和所有阻止规则约束。</p>}
    {error && <p role="alert">{error}</p>}
    <div className="permission-row-actions"><button type="button" onClick={() => {
      try {
        const id = rule?.id ?? `rule-${crypto.randomUUID()}`;
        const next = PermissionRuleSchema.parse({ ...(rule ?? buildRule(template, effect, id)), effect, match: JSON.parse(matchJson) });
        onApply(next);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }}>应用到草稿</button><button type="button" onClick={onCancel}>取消</button></div>
  </section>;
}
