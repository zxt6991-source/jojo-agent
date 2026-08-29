import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  ProviderSettingsSchema,
  WorkerCommandSchema,
  WorkerMessageSchema
} from '../src/index.js';

const settings = ProviderSettingsSchema.parse({});

const commandSamples: unknown[] = [
  { type: 'turn.start', payload: { sessionId: 's', text: 'hello', providerId: 'openai', model: 'gpt-5-mini', images: [] } },
  { type: 'turn.cancel', sessionId: 's' },
  { type: 'session.stop', requestId: 'r', sessionId: 's' },
  { type: 'workflow.cancel', sessionId: 's', workflowId: 'w' },
  { type: 'workflow.resume', requestId: 'r', sessionId: 's', workflowId: 'w' },
  { type: 'approval.resolve', requestId: 'r', allow: false },
  { type: 'approval.resolve', requestId: 'r', allow: true, scope: 'similar' },
  { type: 'approval.resolve', requestId: 'r', allow: true, scope: 'conversation' },
  { type: 'config.update', settings, apiKeys: {}, mcpOAuthCredentials: {} },
  { type: 'mcp.oauth.start', requestId: 'r', serverId: 'm', redirectUrl: 'http://127.0.0.1/callback', state: 'state' },
  { type: 'mcp.oauth.callback', requestId: 'r', serverId: 'm', callbackParams: 'code=ok' },
  { type: 'mcp.oauth.disconnect', requestId: 'r', serverId: 'm' },
  { type: 'mcp.reconnect', requestId: 'r', serverId: 'm' },
  {
    type: 'browser.heal.request', requestId: 'r', sessionId: 's',
    request: { action: 'click', url: 'https://example.com/', candidates: [] }
  },
  { type: 'browser.progress', requestId: 'r', text: '1/3 opening login' },
  { type: 'browser.result', requestId: 'r', result: { callId: 'c', ok: true, content: 'ok' } },
  { type: 'hooks.invalidate', requestId: 'r' },
  { type: 'memory.status', requestId: 'r' },
  { type: 'memory.rebuild', requestId: 'r', scope: 'global' },
  { type: 'memory.semantic.rebuild', requestId: 'r' },
  { type: 'memory.delete', requestId: 'r', scope: 'global', entryId: 'e' },
  { type: 'memory.candidate.accept', requestId: 'r', candidateId: 'c', userConfirmed: true },
  { type: 'memory.candidate.reject', requestId: 'r', candidateId: 'c' }
];

const messageSamples: unknown[] = [
  { type: 'ready' },
  { type: 'agent.event', event: { type: 'turn.cancelled' } },
  { type: 'orchestration.event', event: { type: 'workflow.log', runId: 'w', level: 'info', message: 'ok', createdAt: new Date().toISOString() } },
  { type: 'session.stopped', requestId: 'r', sessionId: 's', ok: true },
  { type: 'workflow.action.result', requestId: 'r', ok: true },
  { type: 'sessions.changed' },
  { type: 'extensions.status', status: { mcpServers: [], skills: [] } },
  { type: 'mcp.oauth.authorization', requestId: 'r', url: 'https://example.com/oauth' },
  { type: 'mcp.oauth.credentials', serverId: 'm', credentials: { accessToken: 'redacted' } },
  { type: 'mcp.oauth.result', requestId: 'r', ok: true },
  { type: 'browser.request', requestId: 'r', sessionId: 's', action: { action: 'pages' }, approved: false },
  { type: 'browser.cancel', requestId: 'r' },
  { type: 'browser.heal.result', requestId: 'r', proposal: { selector: '#save', confidence: 0.9 } },
  { type: 'hooks.invalidated', requestId: 'r', ok: true },
  { type: 'memory.result', requestId: 'r', ok: true, status: { root: '/tmp', ftsMode: 'none', projectAvailable: false, scopes: [] } },
  { type: 'worker.error', message: 'failed' }
];

describe('desktop worker IPC contracts', () => {
  it('accepts every WorkerCommand branch', () => {
    for (const sample of commandSamples) expect(WorkerCommandSchema.safeParse(sample).success).toBe(true);
  });

  it('accepts every WorkerMessage branch', () => {
    for (const sample of messageSamples) expect(WorkerMessageSchema.safeParse(sample).success).toBe(true);
  });

  it('rejects unknown types and unknown top-level fields', () => {
    expect(WorkerCommandSchema.safeParse({ type: 'turn.explode' }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ type: 'turn.cancel', sessionId: 's', admin: true }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({
      type: 'turn.start',
      payload: { sessionId: 's', text: 'hello', providerId: 'openai', model: 'gpt-5-mini', images: [], admin: true }
    }).success).toBe(false);
    expect(WorkerMessageSchema.safeParse({ type: 'ready', payload: 'unexpected' }).success).toBe(false);
  });

  it('rejects malformed nested payloads and non-finite numbers', () => {
    expect(WorkerCommandSchema.safeParse({
      type: 'turn.start', payload: { sessionId: 's', text: 'x', providerId: 'p', model: 'm', images: 'not-an-array' }
    }).success).toBe(false);
    expect(WorkerMessageSchema.safeParse({
      type: 'browser.request', requestId: 'r', sessionId: 's', action: { action: 'select_page', pageId: Number.NaN }, approved: false
    }).success).toBe(false);
  });

  it('rejects oversized fields and malformed approvals', () => {
    expect(AgentEventSchema.safeParse({ type: 'text.delta', text: 'x'.repeat(100_001) }).success).toBe(false);
    expect(AgentEventSchema.safeParse({
      type: 'approval.required', request: { requestId: '', sessionId: 's', call: { id: 'c', name: 'write_file', input: {} }, reason: 'write' }
    }).success).toBe(false);
  });
});
