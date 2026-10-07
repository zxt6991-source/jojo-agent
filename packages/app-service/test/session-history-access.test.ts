import type { ApplicationContext } from '@desktop-agent/contracts/application';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { SessionSearchQuerySchema, SessionReadWindowQuerySchema } from '@desktop-agent/contracts';
import { MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import { createJojoAppService } from '../src/index.js';
const local = { requestId: 'test', principal: { id: 'local', type: 'local' as const, scopes: [] } };
const remote = { requestId: 'test', principal: { id: 'remote', type: 'token' as const, scopes: ['sessions:read', 'all'] } };
async function fixture(policy?: (ctx: ApplicationContext, id: string) => boolean) {
  const store = new MemoryAgentRuntimeStore();
  const search = vi.fn<(query: unknown, allowed: readonly string[]) => Promise<never[]>>(async () => []);
  const read = vi.fn(async () => ({ items: [], truncated: false }));
  const runtime = createAgentRuntime({ store, environment: { host: { kind: 'test' }, providers: { resolve: () => ({ async *stream() { yield { type: 'response_completed' as const, stopReason: 'stop' }; } }) }, tools: { resolve: () => ({ snapshot: () => [] }) }, permissions: { check: async () => ({ decision: 'deny', reason: 'unused' }) } } });
  const app = createJojoAppService(runtime, { ...(policy ? { canReadSessionHistory: policy } : {}) });
  runtime.searchSessionMessages = search;
  runtime.readSessionMessageWindow = read;
  await app.openSession(local, { id: 'current', executionScope: { kind: 'workspace', workingDirectory: '/project' } });
  await app.openSession(local, { id: 'private', executionScope: { kind: 'workspace', workingDirectory: '/project' } });
  await app.openSession(local, { id: 'other-project', executionScope: { kind: 'workspace', workingDirectory: '/other' } });
  return { app, search, read };
}
describe('App Service history identity boundary', () => {
  it('does not treat generic remote scopes as access to private conversations', async () => {
    const f = await fixture();
    try {
      await expect(f.app.searchSessionHistory!(remote, 'current', SessionSearchQuerySchema.parse({ query: 'decision', source: 'all' }))).rejects.toThrow('forbidden');
      expect(f.search).not.toHaveBeenCalled();
      await f.app.searchSessionHistory!(local, 'current', SessionSearchQuerySchema.parse({ query: 'decision' }));
      expect(f.search.mock.calls[0]).toEqual([expect.anything(), expect.arrayContaining(['current', 'private'])]);
      expect(f.search.mock.calls[0]?.[1]).toHaveLength(2);
    } finally { await f.app.close(); }
  });
  it('filters allowed sessions before searching and rejects forbidden windows', async () => {
    const f = await fixture((_ctx, id) => id === 'current');
    try {
      await f.app.searchSessionHistory!(remote, 'current', SessionSearchQuerySchema.parse({ query: 'decision', source: 'all' }));
      expect(f.search.mock.calls[0]).toEqual([expect.anything(), ['current']]);
      await expect(f.app.readSessionHistoryWindow!(remote, SessionReadWindowQuerySchema.parse({ sessionId: 'private', anchorSeq: 1 }))).rejects.toThrow('forbidden');
      expect(f.read).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
