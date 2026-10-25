import { expect, it, vi } from 'vitest';
import type { ConversationMapResult, SessionMeta, WorkerMessage } from '@desktop-agent/contracts';
import { createConversationMapController } from './conversation-map-controller';

const request = { requestId: 'map-1', range: '30d' as const, scope: { kind: 'personal_main' as const } };
const session: SessionMeta = { id: 's1', title: 'test', workingDirectory: '/tmp', projectBound: true, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
const result: ConversationMapResult = {
  version: 1, generatedAt: session.createdAt, rangeStart: session.createdAt, rangeEnd: session.createdAt,
  scopeKind: 'personal_main', analyzedTurnCount: 1, analyzedSessionCount: 1, truncated: false,
  topics: [{ id: 't', title: 'test', summary: 'test', keywords: [], subtopics: [], links: [], steps: [{
    id: 'n', topicId: 't', occurredAt: session.createdAt, kind: 'question', text: 'test',
    references: [{ sessionId: 's1', entryId: 'e1', seq: 1, createdAt: session.createdAt, role: 'user' }]
  }] }]
};
function fixture() {
  let sessions = [session];
  const post = vi.fn((_event: WorkerMessage) => {});
  const readSource = vi.fn(async () => ({ available: false as const }));
  const generate = vi.fn(async () => result);
  const controller = createConversationMapController({ listSessions: async () => sessions, generate, readSource, post });
  return { controller, post, generate, readSource, remove: () => { sessions = []; } };
}

it('rejects a forged project directory before reading history or invoking the model', async () => {
  const f = fixture();
  f.controller.handle({ type: 'conversation-map.generate', input: { ...request, currentSessionId: session.id, scope: { kind: 'project', workingDirectory: '/' } } });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'conversation-map.failed' }) })));
  expect(f.generate).not.toHaveBeenCalled();
});

it('suppresses a late completion after cancellation', async () => {
  const f = fixture();
  let finish!: (value: ConversationMapResult) => void;
  f.generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  f.controller.handle({ type: 'conversation-map.generate', input: request });
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalled());
  f.controller.handle({ type: 'conversation-map.cancel', requestId: request.requestId });
  finish(result);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.post.mock.calls.some(([m]) => m.type === 'conversation-map.event' && m.event.type === 'conversation-map.completed')).toBe(false);
});

it('rechecks deletion at completion and source access, and rejects unknown evidence', async () => {
  const f = fixture();
  f.controller.handle({ type: 'conversation-map.generate', input: request });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'conversation-map.completed' }) })));
  f.controller.handle({ type: 'conversation-map.source', requestId: 'rpc1', input: { requestId: request.requestId, sessionId: 's1', entryId: 'invented' } });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith({ type: 'conversation-map.source.result', requestId: 'rpc1', result: { available: false } }));
  expect(f.readSource).not.toHaveBeenCalled();
  f.remove();
  f.controller.handle({ type: 'conversation-map.source', requestId: 'rpc2', input: { requestId: request.requestId, sessionId: 's1', entryId: 'e1' } });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith({ type: 'conversation-map.source.result', requestId: 'rpc2', result: { available: false } }));
  expect(f.readSource).not.toHaveBeenCalled();
});

it('authorizes V2 evidence and invalidates the result when an exact quote disappears', async () => {
  const reference = result.version === 1 ? result.topics[0]!.steps[0]!.references[0]! : undefined;
  const v2: ConversationMapResult = {
    version: 2, generatedAt: session.createdAt, rangeStart: session.createdAt, rangeEnd: session.createdAt,
    scopeKind: 'personal_main', analyzedTurnCount: 1, analyzedSessionCount: 1, modelCallCount: 1, omittedEventCount: 0, truncated: false,
    topics: [{ id: 't', title: 'test', summary: 'test', changes: [], insights: [], visibleEventIds: ['v'], events: [{
      id: 'v', topicId: 't', subjectKey: 'test', dimensionKey: 'test', eventType: 'position', state: 'considering', speaker: 'user',
      claim: '只需手动生成', occurredAt: session.createdAt, truncatedSource: false, evidence: [{ reference: reference!, quote: '只需手动生成' }]
    }] }]
  };
  const post = vi.fn((_event: WorkerMessage) => {});
  const readSource = vi.fn(async () => ({ available: true as const, reference: reference!, messageId: 'm', text: '只需手动生成', truncated: false }));
  const controller = createConversationMapController({ listSessions: async () => [session], generate: async () => v2, readSource, post });
  controller.handle({ type: 'conversation-map.generate', input: request });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'conversation-map.completed' }) })));
  const input = { requestId: request.requestId, sessionId: 's1', entryId: 'e1' };
  controller.handle({ type: 'conversation-map.source', requestId: 'good', input });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'good', result: expect.objectContaining({ available: true }) })));
  readSource.mockResolvedValue({ available: true, reference: reference!, messageId: 'm', text: '已编辑为不同内容', truncated: false });
  controller.handle({ type: 'conversation-map.source', requestId: 'changed', input });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'conversation-map.source.result', requestId: 'changed', result: { available: false } }));
  readSource.mockClear();
  controller.handle({ type: 'conversation-map.source', requestId: 'invalidated', input });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'conversation-map.source.result', requestId: 'invalidated', result: { available: false } }));
  expect(readSource).not.toHaveBeenCalled();
});
