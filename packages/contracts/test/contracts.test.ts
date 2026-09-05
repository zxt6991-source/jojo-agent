import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ContentBlockSchema,
  BindSessionProjectInputSchema,
  BrowserActionSchema,
  BrowserRecordingRegistrySnapshotSchema,
  BrowserRecordingDocumentSchema,
  CreateSessionInputSchema,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_PROVIDERS,
  DEFAULT_SESSION_TITLE,
  IPC,
  ListModelsInputSchema,
  MessageSchema,
  MemorySettingsSchema,
  ProviderSettingsSchema,
  ExtensionSettingsSchema,
  PermissionPolicyDocumentSchema,
  SavePermissionPolicyInputSchema,
  SaveSettingsInputSchema,
  SessionRecordSchema,
  StartTurnInputSchema,
  SESSION_TITLE_MAX_LENGTH,
  migrateBrowserRecording,
  sessionTitleFromPrompt,
  slugifyBrowserRecordingName,
  isPlaceholderSessionTitle,
  type DesktopApi,
  type Message
} from '../src';

const message = {
  id: 'message-1',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello' }],
  createdAt: '2026-08-09T00:00:00.000Z'
} as const;

describe('contracts', () => {
  it('composes content blocks into messages and persisted records', () => {
    expect(ContentBlockSchema.parse(message.content[0])).toEqual(message.content[0]);
    expect(MessageSchema.parse(message)).toEqual(message);
    expect(SessionRecordSchema.parse({ schemaVersion: 1, type: 'message', message })).toEqual({
      schemaVersion: 1,
      type: 'message',
      message
    });
  });

  it('persists scheduler delivery metadata on assistant messages', () => {
    expect(MessageSchema.parse({
      ...message,
      metadata: {
        source: 'scheduler',
        automation: {
          scheduleId: 'sch_1', scheduleRunId: 'sr_1', name: 'Daily',
          triggeredAt: '2026-08-30T00:00:00.000Z'
        }
      }
    })).toMatchObject({ metadata: { source: 'scheduler', automation: { scheduleId: 'sch_1' } } });
  });

  it('applies provider defaults without adding them to save-settings input', () => {
    expect(ProviderSettingsSchema.parse({})).toEqual({
      activeProviderId: 'openai',
      providers: DEFAULT_PROVIDERS,
      utilityModel: { providerId: 'openai', model: 'gpt-5-mini' },
      permissions: { mode: 'ask' },
      memory: DEFAULT_MEMORY_SETTINGS,
      extensions: { mcpServers: [], skills: { directories: [], disabled: [] }, browser: { ...DEFAULT_BROWSER_SETTINGS } }
    });
    expect(SaveSettingsInputSchema.parse({
      activeProviderId: 'custom',
      provider: {
        id: 'custom', name: 'Custom', protocol: 'openai_chat_completions', baseUrl: 'https://example.com/v1',
        model: 'model', models: ['model', 'other'], contextWindowTokens: 32_000, maxOutputTokens: 2_000
      },
      utilityModel: { providerId: 'custom', model: 'model' },
      permissions: { mode: 'auto' }
    })).toMatchObject({ activeProviderId: 'custom', provider: { model: 'model' }, permissions: { mode: 'auto' } });
    expect(() => SaveSettingsInputSchema.parse({})).toThrow();
  });

  it('keeps suggestions disabled by default and migrates the legacy zero candidate limit', () => {
    expect(DEFAULT_MEMORY_SETTINGS.suggestions).toMatchObject({
      enabled: false, maxPerTurn: 3, evidenceMaxTokens: 2_048, minEligibilityScore: 30
    });
    expect(MemorySettingsSchema.parse({ suggestions: { enabled: false, maxPerTurn: 0 } }).suggestions.maxPerTurn).toBe(3);
  });

  it('keeps Semantic Memory disabled with bounded hybrid defaults', () => {
    expect(DEFAULT_MEMORY_SETTINGS.semantic).toEqual({
      enabled: false,
      mode: 'local-linear',
      remoteAllowed: false,
      searchMode: 'hybrid',
      maxSemanticCandidates: 10_000,
      indexDaily: false,
      indexScratchpad: false,
      rerankEnabled: false
    });
  });

  it('accepts deterministic permission rules and requires workspace identity', () => {
    expect(PermissionPolicyDocumentSchema.parse({
      version: 1,
      rules: [{
        id: 'deny-scheduler-secrets', effect: 'deny',
        match: { actors: ['main'], triggers: ['scheduler'], hasSecrets: true }
      }]
    })).toMatchObject({ rules: [{ id: 'deny-scheduler-secrets' }] });
    expect(() => PermissionPolicyDocumentSchema.parse({
      version: 1, rules: [{ id: 'unsafe-expression', effect: 'allow', match: { expression: 'true' } }]
    })).toThrow();
    expect(() => SavePermissionPolicyInputSchema.parse({
      scope: 'workspace', mode: 'ask', document: { version: 1, rules: [] }
    })).toThrow(/working directory/u);
  });

  it('validates MCP transports and rejects duplicate server ids', () => {
    expect(ExtensionSettingsSchema.parse({
      mcpServers: [
        { id: 'local', name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'] },
        { id: 'remote', name: 'Remote', transport: 'streamable_http', url: 'https://example.com/mcp', auth: { type: 'oauth', scopes: ['read'], resourceOrigins: ['https://region.example.com/'] } }
      ],
      skills: { directories: ['/skills'], disabled: ['one'] }
    })).toMatchObject({
      mcpServers: [{ enabled: true }, { enabled: true, versionNegotiation: 'auto' }]
    });
    expect(ExtensionSettingsSchema.parse({
      mcpServers: [{
        id: 'legacy', name: 'Legacy', transport: 'streamable_http',
        url: 'https://example.com/mcp', versionNegotiation: 'legacy'
      }]
    }).mcpServers[0]).toMatchObject({ versionNegotiation: 'legacy' });
    expect(() => ExtensionSettingsSchema.parse({
      mcpServers: [{ id: 'remote', name: 'Remote', transport: 'streamable_http', url: 'https://example.com/mcp', auth: { type: 'basic' } }]
    })).toThrow();
    expect(() => ExtensionSettingsSchema.parse({
      mcpServers: [{ id: 'remote', name: 'Remote', transport: 'streamable_http', url: 'https://example.com/mcp', auth: { type: 'oauth', resourceOrigins: ['https://region.example.com/path'] } }]
    })).toThrow(/HTTPS origin/u);
    expect(() => ExtensionSettingsSchema.parse({
      mcpServers: [
        { id: 'same', name: 'A', transport: 'stdio', command: 'a' },
        { id: 'same', name: 'B', transport: 'stdio', command: 'b' }
      ]
    })).toThrow(/Duplicate MCP server id/u);
  });

  it('enforces IPC input boundaries', () => {
    expect(StartTurnInputSchema.parse({ sessionId: 'session-1', text: '  hello  ', providerId: ' openai ', model: '  model-b  ' })).toEqual({
      sessionId: 'session-1',
      text: 'hello',
      providerId: 'openai',
      model: 'model-b',
      images: [],
      files: []
    });
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: ' '.repeat(2), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'a'.repeat(100_001), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'hello', model: ' ' })).toThrow();
    expect(StartTurnInputSchema.parse({
      sessionId: 'session-1', text: '', providerId: 'openai', model: 'vision',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'image.png' }]
    }).images).toHaveLength(1);
    expect(() => BrowserActionSchema.parse({ action: 'open', url: 'not-a-url' })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'new_page', url: 'https://example.com/' }))
      .toEqual({ action: 'new_page', url: 'https://example.com/' });
    expect(BrowserActionSchema.parse({ action: 'pages' })).toEqual({ action: 'pages' });
    expect(BrowserActionSchema.parse({ action: 'select_page', pageId: 2 })).toEqual({ action: 'select_page', pageId: 2 });
    expect(() => BrowserActionSchema.parse({ action: 'close_page', pageId: 0 })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'record_start', name: ' Checkout ' }))
      .toEqual({ action: 'record_start', name: 'Checkout', mode: 'agent_trace' });
    expect(BrowserActionSchema.parse({ action: 'record_start', mode: 'user_demo' }))
      .toEqual({ action: 'record_start', mode: 'user_demo' });
    expect(BrowserActionSchema.parse({ action: 'record_stop' })).toEqual({ action: 'record_stop' });
    expect(BrowserActionSchema.parse({ action: 'record_cancel' })).toEqual({ action: 'record_cancel' });
    expect(BrowserActionSchema.parse({ action: 'recordings' })).toEqual({ action: 'recordings' });
    expect(BrowserActionSchema.parse({ action: 'record_get', recordingId: 'github-search' }))
      .toEqual({ action: 'record_get', recordingId: 'github-search' });
    expect(BrowserActionSchema.parse({ action: 'record_delete', recordingId: 'r1' }))
      .toEqual({ action: 'record_delete', recordingId: 'r1' });
    expect(BrowserActionSchema.parse({ action: 'replay', recordingId: 'r2' })).toEqual({
      action: 'replay', recordingId: 'r2', params: {}, maxRetries: 2, retryDelayMs: 250,
      confirmUnsafeResume: false
    });
    expect(BrowserActionSchema.parse({ action: 'replay', recordingId: 'github-search', params: { keyword: 'jojo' } }))
      .toMatchObject({ action: 'replay', recordingId: 'github-search', params: { keyword: 'jojo' } });
    expect(() => BrowserActionSchema.parse({ action: 'replay', recordingId: 'Recording_2' })).toThrow();
    expect(() => BrowserActionSchema.parse({ action: 'replay', recordingId: 'r2', maxRetries: 4 })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'screenshot' })).toEqual({ action: 'screenshot', fullPage: false });
    expect(BrowserActionSchema.parse({ action: 'wait', selector: '#ready' })).toEqual({
      action: 'wait', selector: '#ready', state: 'visible', timeoutMs: 5_000
    });
    expect(BrowserActionSchema.parse({ action: 'click', ref: 'e12' })).toEqual({ action: 'click', ref: 'e12' });
    expect(BrowserActionSchema.parse({
      action: 'click', selector: '#pay', frame: { selectors: ['iframe[name="payment"]'] }
    })).toEqual({
      action: 'click', selector: '#pay', frame: { selectors: ['iframe[name="payment"]'] }
    });
    expect(BrowserActionSchema.parse({
      action: 'read', frame: { selectors: ['iframe[name="payment"]'] }
    })).toEqual({
      action: 'read', maxNodes: 300, frame: { selectors: ['iframe[name="payment"]'] }
    });
    expect(() => BrowserActionSchema.parse({ action: 'click', selector: '#pay', frame: { selectors: [] } })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'hover', selector: '#menu' })).toEqual({ action: 'hover', selector: '#menu' });
    expect(BrowserActionSchema.parse({ action: 'eval', js: 'document.title' })).toEqual({ action: 'eval', js: 'document.title' });
    expect(BrowserActionSchema.parse({ action: 'cookies' })).toEqual({ action: 'cookies', includeValues: false });
    expect(BrowserActionSchema.parse({ action: 'cookies', includeValues: true })).toEqual({ action: 'cookies', includeValues: true });
    expect(() => BrowserActionSchema.parse({ action: 'eval', js: '' })).toThrow();
    expect(() => BrowserActionSchema.parse({ action: 'hover' })).toThrow(/selector or ref/u);
    expect(BrowserActionSchema.parse({ action: 'type', ref: 'e3', text: 'hello' }))
      .toEqual({ action: 'type', ref: 'e3', text: 'hello', submit: false });
    expect(() => BrowserActionSchema.parse({ action: 'click' })).toThrow(/selector or ref/u);
    expect(() => BrowserActionSchema.parse({ action: 'click', selector: '#save', ref: 'e1' })).toThrow(/either selector or ref/u);
    expect(() => BrowserActionSchema.parse({ action: 'click', ref: 'button-1' })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'scroll' })).toEqual({ action: 'scroll', deltaX: 0, deltaY: 600 });
    expect(BrowserActionSchema.parse({ action: 'press', key: 'Enter' })).toEqual({ action: 'press', key: 'Enter' });
    expect(() => BrowserActionSchema.parse({ action: 'press', key: 'Control' })).toThrow();
    expect(() => BrowserActionSchema.parse({ action: 'select', selector: '#country', values: [] })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'upload', selector: '#file', paths: ['report.pdf'] }))
      .toEqual({ action: 'upload', selector: '#file', paths: ['report.pdf'] });
    expect(() => BrowserActionSchema.parse({ action: 'upload', selector: '#file', paths: [] })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'console' })).toEqual({ action: 'console', limit: 80, clear: false });
    expect(BrowserActionSchema.parse({ action: 'console', level: 'error', limit: 20, clear: true }))
      .toEqual({ action: 'console', level: 'error', limit: 20, clear: true });
    expect(() => BrowserActionSchema.parse({ action: 'console', level: 'fatal' })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'network' })).toEqual({
      action: 'network', failedOnly: false, limit: 80, clear: false
    });
    expect(BrowserActionSchema.parse({ action: 'network', failedOnly: true, urlContains: '/api', resourceType: 'xhr' }))
      .toMatchObject({ action: 'network', failedOnly: true, urlContains: '/api', resourceType: 'xhr' });
    expect(() => BrowserActionSchema.parse({ action: 'network', resourceType: 'fetch' })).toThrow();
    expect(BrowserActionSchema.parse({ action: 'errors' })).toEqual({ action: 'errors', limit: 50, clear: false });
    expect(BrowserActionSchema.parse({ action: 'errors', kind: 'exception', limit: 10 }))
      .toEqual({ action: 'errors', kind: 'exception', limit: 10, clear: false });
    expect(() => BrowserActionSchema.parse({ action: 'errors', kind: 'crash' })).toThrow();
    expect(ListModelsInputSchema.parse({ protocol: 'openai_chat_completions', baseUrl: 'https://provider.example/v1' })).toEqual({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://provider.example/v1'
    });
    expect(() => ListModelsInputSchema.parse({ baseUrl: 'not-a-url' })).toThrow();
  });

  it('validates bounded Browser Recording Registry metadata', () => {
    expect(BrowserRecordingRegistrySnapshotSchema.parse({
      userDirectory: '/home/jojo/.jojo/browser-recordings',
      projectDirectory: '/workspace/.jojo/browser-recordings',
      recordings: [{
        id: 'monthly-report', name: 'Monthly Report', source: 'project', trust: 'untrusted',
        overriddenSources: ['user'], domains: ['example.com'], effects: ['download report'], highRisk: true,
        stepCount: 4, revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, updatedAt: '2026-08-25T00:00:00.000Z'
      }]
    })).toMatchObject({ recordings: [{ source: 'project', trust: 'untrusted', highRisk: true }] });
  });

  it('validates persisted browser recordings and slug ids', () => {
    expect(slugifyBrowserRecordingName('GitHub Search')).toBe('github-search');
    expect(migrateBrowserRecording({
      id: 'github-search',
      name: 'GitHub Search',
      createdAt: '2026-08-15T00:00:00.000Z',
      steps: [{ action: 'click', selector: 'input[name="q"]', fingerprint: { tag: 'input', fieldName: 'q' } }]
    })).toMatchObject({
      version: 2,
      id: 'github-search',
      params: [],
      revision: 1,
      steps: [{ id: 'step-1', action: 'click', target: { selector: 'input[name="q"]' } }]
    });
    expect(() => BrowserRecordingDocumentSchema.parse({
      version: 2, id: 'dup', name: 'Dup', createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z', params: [{ name: 'q' }, { name: 'q' }], steps: []
    })).toThrow(/Duplicate recording param/u);
  });

  it('creates a compact session title from the first prompt', () => {
    expect(DEFAULT_SESSION_TITLE).toBe('新会话');
    expect(sessionTitleFromPrompt('  第一行\n\n第二行   内容  ')).toBe('第一行 第二行 内容');
    const emojiTitle = sessionTitleFromPrompt('🙂'.repeat(SESSION_TITLE_MAX_LENGTH + 5));
    expect(emojiTitle).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(emojiTitle.endsWith('\ud83d')).toBe(false);
    expect(isPlaceholderSessionTitle('project', '/workspace/project')).toBe(true);
    expect(isPlaceholderSessionTitle('手动标题', '/workspace/project')).toBe(false);
  });

  it('allows creating a session without selecting a project', () => {
    expect(CreateSessionInputSchema.parse({ title: '新会话' })).toEqual({ title: '新会话' });
    expect(() => CreateSessionInputSchema.parse({ title: '新会话', workingDirectory: '  ' })).toThrow();
    expect(BindSessionProjectInputSchema.parse({ sessionId: 'session-1', workingDirectory: ' /repo ' }))
      .toEqual({ sessionId: 'session-1', workingDirectory: '/repo' });
  });

  it('keeps the root barrel API usable by consumers', () => {
    expect(IPC.startTurn).toBe('agent:start');
    expect(IPC.listModels).toBe('models:list');
    expect(IPC.probeChromeBrowser).toBe('browser:chrome-probe');
    expect(IPC.browserDockLayout).toBe('browser:dock-layout');
    expect(IPC.browserDockAction).toBe('browser:dock-action');
    expect(IPC.browserDockState).toBe('browser:dock-state');
    expect(IPC.getHookStatus).toBe('hooks:status');
    expect(IPC.reloadHooks).toBe('hooks:reload');
    expect(IPC.trustProjectHooks).toBe('hooks:trust');
    expect(IPC.disableProjectHooks).toBe('hooks:disable');
    expect(IPC.openHookConfig).toBe('hooks:open-config');
    expect(IPC.saveMemorySettings).toBe('memory:settings-save');
    expect(IPC.getMemoryStatus).toBe('memory:status');
    expect(IPC.rebuildMemoryIndex).toBe('memory:rebuild-index');
    expect(IPC.deleteMemoryEntry).toBe('memory:entry-delete');
    expectTypeOf<DesktopApi['setBrowserDockLayout']>().toBeFunction();
    expectTypeOf<DesktopApi['browserDockAction']>().toBeFunction();
    expectTypeOf<DesktopApi['listBrowserRecordings']>().toBeFunction();
    expectTypeOf<DesktopApi['trustProjectBrowserRecording']>().toBeFunction();
    expectTypeOf<DesktopApi['revokeProjectBrowserRecordingTrust']>().toBeFunction();
    expectTypeOf<DesktopApi['deleteBrowserRecording']>().toBeFunction();
    expectTypeOf<DesktopApi['onBrowserDockState']>().toBeFunction();
    expectTypeOf<DesktopApi['getHookStatus']>().toBeFunction();
    expectTypeOf<DesktopApi['reloadHooks']>().toBeFunction();
    expectTypeOf<DesktopApi['trustProjectHooks']>().toBeFunction();
    expectTypeOf<DesktopApi['disableProjectHooks']>().toBeFunction();
    expectTypeOf<DesktopApi['openHookConfig']>().toBeFunction();
    expectTypeOf<DesktopApi['saveMemorySettings']>().toBeFunction();
    expectTypeOf<DesktopApi['getMemoryStatus']>().toBeFunction();
    expectTypeOf<DesktopApi['rebuildMemoryIndex']>().toBeFunction();
    expectTypeOf<DesktopApi['deleteMemoryEntry']>().toBeFunction();
    expectTypeOf<(typeof MessageSchema)['_output']>().toEqualTypeOf<Message>();
    expectTypeOf<DesktopApi['startTurn']>().toBeFunction();
  });
});
