import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ContentBlockSchema,
  DEFAULT_PROVIDERS,
  DEFAULT_SESSION_TITLE,
  IPC,
  ListModelsInputSchema,
  MessageSchema,
  ProviderSettingsSchema,
  ExtensionSettingsSchema,
  SaveSettingsInputSchema,
  SessionRecordSchema,
  StartTurnInputSchema,
  SESSION_TITLE_MAX_LENGTH,
  sessionTitleFromPrompt,
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

  it('applies provider defaults without adding them to save-settings input', () => {
    expect(ProviderSettingsSchema.parse({})).toEqual({
      activeProviderId: 'openai',
      providers: DEFAULT_PROVIDERS,
      utilityModel: { providerId: 'openai', model: 'gpt-5-mini' },
      extensions: { mcpServers: [], skills: { directories: [], disabled: [] } }
    });
    expect(SaveSettingsInputSchema.parse({
      activeProviderId: 'custom',
      provider: {
        id: 'custom', name: 'Custom', protocol: 'openai_chat_completions', baseUrl: 'https://example.com/v1',
        model: 'model', models: ['model', 'other'], contextWindowTokens: 32_000, maxOutputTokens: 2_000
      },
      utilityModel: { providerId: 'custom', model: 'model' }
    })).toMatchObject({ activeProviderId: 'custom', provider: { model: 'model' } });
    expect(() => SaveSettingsInputSchema.parse({})).toThrow();
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
      model: 'model-b'
    });
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: ' '.repeat(2), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'a'.repeat(100_001), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'hello', model: ' ' })).toThrow();
    expect(ListModelsInputSchema.parse({ protocol: 'openai_chat_completions', baseUrl: 'https://provider.example/v1' })).toEqual({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://provider.example/v1'
    });
    expect(() => ListModelsInputSchema.parse({ baseUrl: 'not-a-url' })).toThrow();
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

  it('keeps the root barrel API usable by consumers', () => {
    expect(IPC.startTurn).toBe('agent:start');
    expect(IPC.listModels).toBe('models:list');
    expectTypeOf<(typeof MessageSchema)['_output']>().toEqualTypeOf<Message>();
    expectTypeOf<DesktopApi['startTurn']>().toBeFunction();
  });
});
