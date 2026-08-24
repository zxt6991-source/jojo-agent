import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_SETTINGS } from '@desktop-agent/contracts';
import { MemoryScopeConfigDialog, MemorySettingsPage } from './MemorySettings';

describe('MemorySettingsPage', () => {
  it('renders controls and scope index status', () => {
    const html = renderToStaticMarkup(React.createElement(MemorySettingsPage, {
      draft: DEFAULT_MEMORY_SETTINGS,
      saved: DEFAULT_MEMORY_SETTINGS,
      status: {
        root: '/tmp/memory',
        ftsMode: 'trigram',
        projectAvailable: true,
        semantic: {
          enabled: false, mode: 'local-linear', indexedChunks: 12, pending: 1,
          failed: 0, skippedSecret: 2, stale: 0
        },
        scopes: [{
          id: 'global', kind: 'global', displayName: 'Global', version: 3,
          directory: '/tmp/memory/global', contentHash: 'abc', dirty: false, entryCount: 7, warningCount: 0, entries: []
        }],
        pendingCandidates: [{
          id: 'memcand_1', sessionId: 'session-1', operationId: 'operation-1', scopeId: 'global',
          scope: 'global', kind: 'decision', title: 'Use node:sqlite', content: 'Use node:sqlite for Memory.',
          rationale: 'Avoid another native binding.', confidence: 'high', tags: [], suggestedTarget: 'index',
          state: 'pending', fingerprint: 'a'.repeat(64), provenance: [{ source: 'user', verified: true }],
          suggestedMutation: { type: 'create' }, createdAt: 1_000, expiresAt: Date.now() + 1_000
        }]
      },
      error: '',
      busy: false,
      workingDirectory: '/tmp/project',
      onChange: () => undefined,
      onSave: async () => undefined,
      onRefresh: () => undefined,
      onRebuild: () => undefined,
      onDelete: async () => true
    }));

    expect(html).toContain('启用长期记忆');
    expect(html).toContain('Global Memory');
    expect(html).toContain('FTS5 · Trigram');
    expect(html).toContain('7 条 · v3');
    expect(html).toContain('保存 Memory 设置');
    expect(html).toContain('查看配置');
    expect(html).toContain('Pending Suggestions');
    expect(html).toContain('Semantic Search');
    expect(html).toContain('SQLite Linear Cosine');
    expect(html).toContain('Skipped Secret');
    expect(html).toContain('重建 Semantic Index');
    expect(html).toContain('Use node:sqlite');
    expect(html).toContain('接受');
    expect(html).not.toContain('Accept All');
  });

  it('shows the saved configuration and unsaved-change warning', () => {
    const html = renderToStaticMarkup(React.createElement(MemoryScopeConfigDialog, {
      scope: {
        id: 'global', kind: 'global', displayName: 'Global', directory: '/tmp/memory/global', version: 1,
        contentHash: 'hash', dirty: false, entryCount: 1, warningCount: 0,
        entries: [{
          id: 'mem_chinese', scopeId: 'global', kind: 'rule', status: 'confirmed',
          title: '默认使用中文回答', content: '所有回答默认使用中文。', tags: ['language'],
          sourceFile: 'MEMORY.md', createdAt: 1, updatedAt: 1, contentHash: 'entry-hash',
          ruleMode: 'always', unknownMetadata: {}
        }]
      },
      busy: false,
      error: '',
      confirmDelete: true,
      onDelete: async () => true,
      onClose: () => undefined
    }));

    expect(html).toContain('Global Memory 配置');
    expect(html).toContain('/tmp/memory/global');
    expect(html).toContain('默认使用中文回答');
    expect(html).toContain('所有回答默认使用中文');
    expect(html).toContain('always');
    expect(html).toContain('删除');
  });

  it('requires an explicit remote embedding privacy opt-in', () => {
    const memory = {
      ...DEFAULT_MEMORY_SETTINGS,
      semantic: {
        ...DEFAULT_MEMORY_SETTINGS.semantic,
        enabled: true,
        providerId: 'remote',
        model: 'embed-model',
        remoteAllowed: false
      }
    };
    const html = renderToStaticMarkup(React.createElement(MemorySettingsPage, {
      draft: memory,
      saved: memory,
      status: null,
      error: '',
      busy: false,
      providers: [{
        id: 'remote', name: 'Remote Embeddings', protocol: 'openai_chat_completions',
        baseUrl: 'https://embed.example/v1', model: 'embed-model', models: ['embed-model'],
        contextWindowTokens: 32_000, maxOutputTokens: 2_000, hasApiKey: true
      }],
      onChange: () => undefined,
      onSave: async () => undefined,
      onRefresh: () => undefined,
      onRebuild: () => undefined,
      onDelete: async () => true
    }));
    expect(html).toContain('远程 Embedding 隐私确认');
    expect(html).toContain('不会发送完整 Session 或仓库全文');
    expect(html).toContain('允许发送到远程 Embedding Provider');
  });
});
