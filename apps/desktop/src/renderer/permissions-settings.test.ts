import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
      onSave: async () => undefined
    }));
    expect(html).toContain('Recent Decisions');
    expect(html).toContain('auto_low_risk');
    expect(html).toContain('Workspace');
    expect(html).not.toContain('requestFingerprint');
  });
});
