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
        scopes: [{
          id: 'global', kind: 'global', displayName: 'Global', version: 3,
          directory: '/tmp/memory/global', contentHash: 'abc', dirty: false, entryCount: 7, warningCount: 0, entries: []
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
});
