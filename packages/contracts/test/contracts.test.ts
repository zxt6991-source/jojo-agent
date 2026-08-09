import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ContentBlockSchema,
  IPC,
  ListModelsInputSchema,
  MessageSchema,
  ProviderSettingsSchema,
  SaveSettingsInputSchema,
  SessionRecordSchema,
  StartTurnInputSchema,
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
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      models: ['gpt-5-mini'],
      hasApiKey: false
    });
    expect(SaveSettingsInputSchema.parse({ baseUrl: 'https://example.com/v1', model: 'model', models: ['model', 'other'] })).toEqual({
      baseUrl: 'https://example.com/v1',
      model: 'model',
      models: ['model', 'other']
    });
    expect(() => SaveSettingsInputSchema.parse({})).toThrow();
  });

  it('enforces IPC input boundaries', () => {
    expect(StartTurnInputSchema.parse({ sessionId: 'session-1', text: '  hello  ', model: '  model-b  ' })).toEqual({
      sessionId: 'session-1',
      text: 'hello',
      model: 'model-b'
    });
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: ' '.repeat(2), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'a'.repeat(100_001), model: 'model' })).toThrow();
    expect(() => StartTurnInputSchema.parse({ sessionId: 'session-1', text: 'hello', model: ' ' })).toThrow();
    expect(ListModelsInputSchema.parse({ baseUrl: 'https://provider.example/v1' })).toEqual({
      baseUrl: 'https://provider.example/v1'
    });
    expect(() => ListModelsInputSchema.parse({ baseUrl: 'not-a-url' })).toThrow();
  });

  it('keeps the root barrel API usable by consumers', () => {
    expect(IPC.startTurn).toBe('agent:start');
    expect(IPC.listModels).toBe('models:list');
    expectTypeOf<(typeof MessageSchema)['_output']>().toEqualTypeOf<Message>();
    expectTypeOf<DesktopApi['startTurn']>().toBeFunction();
  });
});
