import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionActivity } from './permissions/PermissionActivity';
import { presentRule } from './permissions/permission-rule-presenter';
import { buildRule, ruleTemplates, ruleCovers, ruleWarning } from './permissions/permission-rule-builder';
import { PermissionsSettingsPage, parsePermissionPolicyEditor } from './PermissionsSettings';

describe('PermissionsSettingsPage', () => {
  it('validates deterministic permission policy JSON', () => {
    expect(parsePermissionPolicyEditor(JSON.stringify({
      version: 1,
      rules: [{ id: 'deny-scheduler-secret', effect: 'deny', match: { triggers: ['scheduler'], hasSecrets: true } }]
    }))).toMatchObject({ rules: [{ id: 'deny-scheduler-secret' }] });
    expect(() => parsePermissionPolicyEditor('{bad')).toThrow(/Policy JSON/u);
    expect(() => parsePermissionPolicyEditor(JSON.stringify({ version: 1, rules: [{ id: 'x', effect: 'allow', match: { regex: '.*' } }] }))).toThrow();
  });

  it('renders policy scope and explainable recent decisions', () => {
    const html = renderToStaticMarkup(React.createElement(PermissionsSettingsPage, {
      snapshot: {
        global: { scope: 'global', mode: 'auto', document: { version: 1, rules: [] }, revision: 2 },
        recentDecisions: [{
          id: 'd1', createdAt: '2026-08-29T00:00:00.000Z', sessionId: 's1', actorKind: 'main',
          triggerKind: 'user', toolName: 'terminal', toolSource: 'native', effect: 'allow', locked: false,
          source: 'mode', reasonCode: 'auto_low_risk', requestFingerprint: 'fingerprint', risk: 'medium'
        }]
      },
      workingDirectory: '/workspace', busy: false, error: '', onRefresh: () => undefined,
      onSave: async () => undefined, onReset: async () => undefined
    }));
    expect(html).toContain('权限策略');
    expect(html).toContain('活动记录');
    expect(html).toContain('所有项目');
    expect(html).toContain('当前项目');
    expect(html).toContain('智能自动');
    expect(html).toContain('系统保护');
    expect(html).toContain('hidden="" id="permission-activity-panel"');
  });
});


describe('permission UX adapters', () => {
  it('round-trips every template through the canonical schema', () => {
    for (const [index, template] of ruleTemplates.entries()) {
      const rule = buildRule(index, template.effect, `rule-${index}`);
      expect(parsePermissionPolicyEditor(JSON.stringify({ version: 1, rules: [rule] })).rules[0]).toEqual(rule);
      expect(presentRule(rule)).not.toContain('[object');
    }
    expect(presentRule(buildRule(3, 'deny', 'secret'))).toContain('定时任务');
    expect(presentRule(buildRule(3, 'deny', 'secret'))).toContain('使用密钥');
  });

  it('preserves complex rules, including false and empty conditions', () => {
    const rule = { id: 'complex', effect: 'ask' as const, match: {
      actors: ['workflow' as const], triggers: ['api' as const], sources: ['mcp' as const], tools: ['custom.tool'],
      operations: ['read' as const, 'external_effect' as const], risks: [], network: 'none' as const,
      hasSecrets: false, resourceScope: 'external' as const
    } };
    expect(parsePermissionPolicyEditor(JSON.stringify({ version: 1, rules: [rule] })).rules[0]).toEqual(rule);
    const copy = presentRule(rule);
    for (const condition of ['工作流', '接口调用', 'MCP', 'custom.tool', '读取且外部副作用', '无匹配值', '不使用网络', '不使用密钥', '外部资源']) expect(copy).toContain(condition);
  });

  it('analyzes coverage with AND operations and OR actors without reversing deny priority', () => {
    const broad = { id: 'broad', effect: 'allow' as const, match: { tools: ['terminal'] } };
    const narrow = buildRule(1, 'ask', 'network');
    expect(ruleCovers(broad, narrow)).toBe(true);
    expect(ruleCovers(narrow, broad)).toBe(false);
    expect(ruleWarning(narrow, 1, [broad, narrow])).toContain('前面的规则');
    expect(ruleWarning({ ...narrow, effect: 'deny' }, 1, [broad, narrow])).toBeUndefined();
    expect(ruleWarning(narrow, 0, [narrow], [{ ...broad, effect: 'deny' }])).toContain('阻止规则');
    expect(ruleCovers({ ...broad, match: { operations: ['read'] } }, { ...narrow, match: { operations: ['read', 'write'] } })).toBe(true);
    expect(ruleCovers({ ...broad, match: { operations: ['read', 'write'] } }, { ...narrow, match: { operations: ['read'] } })).toBe(false);
    expect(ruleCovers({ ...broad, match: { actors: [] } }, narrow)).toBe(false);
    expect(ruleCovers({ ...broad, match: { actors: ['main', 'subagent'] } }, { ...narrow, match: { actors: ['main'] } })).toBe(true);
  });

  it('describes audit results without claiming execution succeeded', () => {
    const html = renderToStaticMarkup(React.createElement(PermissionActivity, { sessionScoped: true, items: [{
      id: 'd1', createdAt: '2026-09-18T00:00:00.000Z', sessionId: 's1', actorKind: 'main', triggerKind: 'user',
      toolName: 'terminal', toolSource: 'native', effect: 'allow', locked: false, source: 'mode', reasonCode: 'auto_low_risk',
      requestFingerprint: 'fingerprint', risk: 'medium'
    }] }));
    expect(html).toContain('已允许');
    expect(html).toContain('低风险条件');
    expect(html).toContain('查看技术详情');
    expect(html).not.toContain('已自动执行');
  });
});
