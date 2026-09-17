import { DEFAULT_MEMORY_SETTINGS, legacyModelConfig, type MemoryStatusSnapshot, type ProviderConfig } from '@desktop-agent/contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemorySettingsPage } from './MemorySettings';
import { MemoryAdvancedSettings } from './MemoryAdvancedSettings';
import { MemoryDiagnostics } from './MemoryDiagnostics';
import { MemoryEntries, MemorySavedList } from './MemorySavedList';
import { MemorySuggestions } from './MemorySuggestions';
import { buildMemorySettingsViewModel, isRemoteMemoryProvider } from './memory-settings-model';

const status: MemoryStatusSnapshot = {
  root: '/tmp/memory', ftsMode: 'trigram', projectAvailable: true,
  scopes: [{
    id: 'global', kind: 'global', displayName: 'Global', version: 3,
    directory: '/tmp/memory/global', contentHash: 'abc', dirty: false, entryCount: 1, warningCount: 0,
    entries: [{ id: 'mem_chinese', scopeId: 'global', kind: 'preference', status: 'confirmed', title: '默认使用中文回答', content: '所有回答默认使用中文。', tags: ['language'], sourceFile: 'MEMORY.md', createdAt: 1, updatedAt: 1, contentHash: 'entry-hash', unknownMetadata: {} }]
  }],
  semantic: { enabled: false, mode: 'local-linear', indexedChunks: 12, pending: 1, failed: 0, skippedSecret: 2, stale: 0 },
  pendingCandidates: [{
    id: 'memcand_1', sessionId: 'session-1', operationId: 'operation-1', scopeId: 'global', scope: 'global', kind: 'rule', title: '使用 node:sqlite', content: 'Use node:sqlite for Memory.', rationale: '避免额外原生绑定。', confidence: 'high', tags: [], suggestedTarget: 'index', state: 'pending', fingerprint: 'a'.repeat(64), provenance: [{ source: 'user', verified: true }], suggestedMutation: { type: 'create' }, createdAt: 1_000, expiresAt: 2_000
  }]
};
const remote: ProviderConfig = { id: 'remote', name: 'Remote Embeddings', protocol: 'openai_chat_completions', baseUrl: 'https://embed.example/v1', model: 'embed-model', models: [legacyModelConfig('embed-model', 32_000, 2_000)], hasApiKey: true };
const pageProps: React.ComponentProps<typeof MemorySettingsPage> = {
  draft: DEFAULT_MEMORY_SETTINGS, saved: DEFAULT_MEMORY_SETTINGS, status, error: '', busy: false,
  workingDirectory: '/tmp/project', onChange: () => undefined, onSave: async () => undefined,
  onRefresh: () => undefined, onRebuild: () => undefined, onDelete: async () => true
};

describe('Memory product navigation', () => {
  it('defaults to four core decisions and hides advanced controls and diagnostics', () => {
    const html = renderToStaticMarkup(React.createElement(MemorySettingsPage, pageProps));
    expect(html.match(/role="switch"/g)).toHaveLength(4);
    for (const label of ['启用 Memory', '所有项目', '当前项目', '待确认 1', '管理 Memory', 'Memory 工作正常', '高级设置']) expect(html).toContain(label);
    for (const internal of ['Content Hash', 'SQLite Linear Cosine', 'Evidence 最大 tokens', 'FTS5', '/tmp/memory', '使用 node:sqlite']) expect(html).not.toContain(internal);
  });

  it('shows dirty state and an actionable diagnostics entry without leaking internal fields', () => {
    const html = renderToStaticMarkup(React.createElement(MemorySettingsPage, { ...pageProps, status: { ...status, scopes: status.scopes.map((scope) => ({ ...scope, dirty: true })) } }));
    expect(html).toContain('Memory 搜索需要修复');
    expect(html).toContain('检查与修复');
    expect(html).not.toContain('Content Hash');
  });

  it('shows missing project, loading state, errors and unsaved changes on the overview', () => {
    const props = { ...pageProps };
    delete props.workingDirectory;
    const html = renderToStaticMarkup(React.createElement(MemorySettingsPage, { ...props, status: null, error: '读取失败', draft: { ...DEFAULT_MEMORY_SETTINGS, enabled: false } }));
    expect(html).toContain('当前没有项目');
    expect(html).toContain('尚未读取');
    expect(html).toContain('读取失败');
    expect(html).toContain('有尚未保存的修改');
    expect(html).toContain('放弃修改');
  });

  it('retains advanced capabilities and explicit remote consent', () => {
    const draft = { ...DEFAULT_MEMORY_SETTINGS, semantic: { ...DEFAULT_MEMORY_SETTINGS.semantic, enabled: true, providerId: 'remote', model: 'embed-model', remoteAllowed: false } };
    const html = renderToStaticMarkup(React.createElement(MemoryAdvancedSettings, { draft, providers: [remote], onChange: () => undefined }));
    for (const label of ['Provider', 'Embedding Model', 'Search Mode', 'Evidence 最大 tokens', '保留天数', '恢复上下文推荐值', '远程 Embedding 隐私确认', '不会发送完整 Session 或仓库全文']) expect(html).toContain(label);
    expect(html).toMatch(/aria-checked="false"[^>]*aria-labelledby="memory-semantic-remote-label"/);
    expect(html).not.toContain('删除前要求确认');
  });

  it('exposes index repair and technical details only through diagnostics', () => {
    const html = renderToStaticMarkup(React.createElement(MemoryDiagnostics, { draft: DEFAULT_MEMORY_SETTINGS, status, busy: false, onRefresh: () => undefined, onRebuild: () => undefined }));
    for (const label of ['Content Hash', '/tmp/memory', 'FTS5 · Trigram', '修复索引', '重建 Semantic Index', 'Skipped Secret']) expect(html).toContain(label);
  });

  it('filters saved memories by content and tags, with technical metadata collapsed', () => {
    const scope = status.scopes[0]!;
    const html = renderToStaticMarkup(React.createElement(MemoryEntries, { scope, busy: false, query: 'LANGUAGE', onDelete: async () => true }));
    expect(html).toContain('默认使用中文回答');
    expect(html).toContain('偏好');
    expect(html).toContain('<details class="memory-details"><summary>更多信息');
    expect(html).not.toContain('<details open');
    const filtered = renderToStaticMarkup(React.createElement(MemoryEntries, { scope, busy: false, query: 'does not exist', onDelete: async () => true }));
    expect(filtered).not.toContain('默认使用中文回答');
    expect(filtered).toContain('没有匹配');
  });

  it('does not mistake an unread status for an empty memory list', () => {
    const html = renderToStaticMarkup(React.createElement(MemorySavedList, { status: null, busy: false, projectAvailable: false, onDelete: async () => true, onRefresh: () => undefined }));
    expect(html).toContain('尚未读取记忆');
    expect(html).not.toContain('还没有保存');
  });

  it('keeps rule confirmation and individual review, with confidence in collapsed details', () => {
    const html = renderToStaticMarkup(React.createElement(MemorySuggestions, { candidates: status.pendingCandidates!, busy: false, projectAvailable: true, onAccept: async () => undefined, onReject: async () => undefined }));
    for (const label of ['为什么建议保存', '逐条确认', '忽略', '编辑', '保存 Memory']) expect(html).toContain(label);
    expect(html).toContain('<details class="memory-details"><summary>建议详情');
    expect(html).not.toContain('批量');
  });
});

describe('memory settings view model', () => {
  it('distinguishes unknown, healthy, parsing warnings, semantic failures and operation errors', () => {
    const settings = DEFAULT_MEMORY_SETTINGS;
    expect(buildMemorySettingsViewModel(settings, null).health.level).toBe('unknown');
    expect(buildMemorySettingsViewModel(settings, status).health.level).toBe('healthy');
    expect(buildMemorySettingsViewModel(settings, { ...status, scopes: status.scopes.map((scope) => ({ ...scope, warningCount: 1 })) }).health.message).toBe('部分记忆内容需要检查');
    const failures = { ...status, semantic: { ...status.semantic!, failed: 1 } };
    expect(buildMemorySettingsViewModel(settings, failures).health.level).toBe('healthy');
    expect(buildMemorySettingsViewModel({ ...settings, semantic: { ...settings.semantic, enabled: true } }, failures).health.level).toBe('warning');
    expect(buildMemorySettingsViewModel(settings, status, 'failed').health.level).toBe('error');
    expect(buildMemorySettingsViewModel(settings, status).scopes.globalCount).toBe(1);
  });

  it.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234'])('recognizes the local endpoint %s', (baseUrl) => {
    expect(isRemoteMemoryProvider({ ...remote, baseUrl })).toBe(false);
  });

  it('requires consent for remote or malformed endpoints', () => {
    expect(isRemoteMemoryProvider(remote)).toBe(true);
    expect(isRemoteMemoryProvider({ ...remote, baseUrl: 'invalid' })).toBe(true);
    expect(isRemoteMemoryProvider({ ...remote, baseUrl: 'https://localhost.example' })).toBe(true);
  });
});
