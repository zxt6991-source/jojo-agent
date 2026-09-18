import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_SETTINGS, type BrowserRecordingStudioDetail, type BrowserRecordingRegistrySnapshot } from '@desktop-agent/contracts';
import { BrowserSettingsPage } from './BrowserSettingsPage';
import { BrowserRecordingsPage } from './recordings/BrowserRecordingsPage';
import { BrowserRecordingDetail } from './recordings/BrowserRecordingDetail';
import { BrowserRecordingSteps } from './recordings/BrowserRecordingSteps';
import { BrowserRecordingDeveloperTools } from './developer/BrowserRecordingDeveloperTools';

const noop = () => undefined;
const detail: BrowserRecordingStudioDetail = {
  document: { version: 2, id: 'export-report', name: '导出报表', scope: 'project', domains: ['example.com'], params: [], outputs: [], steps: [{ id: 'navigate', action: 'navigate', url: 'https://example.com' }, { id: 'export', action: 'click', target: { selector: '#internal-selector', fingerprint: { tag: 'button', accessibleName: '导出报表' } } }], revision: 3, contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' },
  source: 'project', trust: 'untrusted', editable: false, timeline: [], revisions: [], replay: [], heals: []
};
const registry: BrowserRecordingRegistrySnapshot = { userDirectory: '/private/recordings', recordings: [{ id: detail.document.id, name: detail.document.name, source: 'project', trust: 'untrusted', overriddenSources: ['user'], domains: ['example.com'], effects: ['click'], highRisk: true, stepCount: 2, revision: 3, contentHash: detail.document.contentHash, updatedAt: detail.document.updatedAt }] };
const settingsProps: React.ComponentProps<typeof BrowserSettingsPage> = { enabled: true, mode: 'sandbox', domains: '', saved: DEFAULT_BROWSER_SETTINGS, recordings: registry, recordingsBusy: false, error: '', onEnabledChange: noop, onModeChange: noop, onDomainsChange: noop, onDiscard: noop, onPermissions: noop, onRecordings: noop, onSubmit: async () => undefined };

describe('browser product hierarchy', () => {
  it('limits the overview to settings and secondary navigation', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserSettingsPage, settingsProps));
    for (const label of ['浏览器访问', '沙箱浏览器', '本机浏览器', '不会读取你日常 Chrome 的登录状态', '管理网站', '查看权限规则', '管理录制任务', '所有设置已保存']) expect(html).toContain(label);
    for (const internal of ['JSON', 'revision', 'sha256', '/private/recordings', '导出报表', 'browser-policy-grid', 'browser-domain-editor']) expect(html).not.toContain(internal);
    expect(html.match(/<button/g)).toHaveLength(4);
  });
  it('shows dirty state, save and discard, without treating ordering as a change', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserSettingsPage, { ...settingsProps, mode: 'chrome', error: '保存失败' }));
    for (const label of ['有尚未保存的修改', '放弃修改', '保存失败']) expect(html).toContain(label);
    const clean = renderToStaticMarkup(React.createElement(BrowserSettingsPage, { ...settingsProps, domains: 'b.com\na.com', saved: { ...DEFAULT_BROWSER_SETTINGS, allowedDomains: ['a.com', 'b.com'] } }));
    expect(clean).toContain('所有设置已保存');
  });
  it('keeps paths and technical metadata out of the asset list', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserRecordingsPage, { recordings: registry, recordingsBusy: false, error: '', onBack: noop, onRefreshRecordings: noop, onTrustRecording: async () => undefined, onRevokeRecording: async () => undefined, onDeleteRecording: async () => true }));
    for (const label of ['导出报表', '项目', '2 个步骤', '包含敏感操作', '搜索录制任务']) expect(html).toContain(label);
    for (const value of ['/private/recordings', 'sha256', 'revision', '<textarea']) expect(html).not.toContain(value);
  });
  it('makes trust and risk review visible while keeping JSON behind developer tools', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserRecordingDetail, { studio: detail, item: registry.recordings[0], busy: false, studioJson: JSON.stringify(detail.document), setStudioJson: noop, onSave: async () => undefined, onBack: noop, onRefresh: noop, onDuplicate: noop, onTrust: noop, onRevoke: noop, onDelete: noop, canManage: true }));
    for (const label of ['概览', '步骤', '运行记录', '此版本尚未信任', '信任并允许使用', '开发者工具']) expect(html).toContain(label);
    for (const value of ['sha256', '<textarea', '回放调试', '版本历史']) expect(html).not.toContain(value);
  });
  it('shows human readable targets without selectors or step ids', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserRecordingSteps, { steps: detail.document.steps }));
    expect(html).toContain('打开 https://example.com');
    expect(html).toContain('点击：导出报表');
    expect(html).not.toContain('#internal-selector');
  });
  it('retains advanced tools and enforces read-only project documents', () => {
    const html = renderToStaticMarkup(React.createElement(BrowserRecordingDeveloperTools, { studio: detail, studioJson: '{}', setStudioJson: noop, studioBusy: false, saveStudio: async () => undefined }));
    for (const label of ['原始 JSON', '回放调试', '选择器修复', '版本历史', 'readOnly']) expect(html).toContain(label);
    expect(html).not.toContain('保存新版本');
  });
});
