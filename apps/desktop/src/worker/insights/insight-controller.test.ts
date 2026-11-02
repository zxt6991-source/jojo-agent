import { expect, it, vi } from 'vitest';
import type { InsightGenerateInput, InsightResult, SessionMeta, WorkerMessage } from '@desktop-agent/contracts';
import { createInsightController, type InsightGenerationContext } from './insight-controller';
import { createHistoryAnalysisTaskGate } from '../history-analysis-task';
import { createConversationMapController } from '../conversation-map-controller';

const timestamp = '2026-10-20T00:00:00.000Z';
const request: InsightGenerateInput = { requestId: 'insight-1', range: '30d', scope: { kind: 'personal_main' }, perspective: 'reverse_thinking' };
const session: SessionMeta = { id: 's', title: 'test', workingDirectory: '/tmp', projectBound: true, createdAt: timestamp, updatedAt: timestamp };
const reference = { sessionId: 's', entryId: 'e', seq: 1, createdAt: timestamp, role: 'user' as const };
const source = { available: true as const, reference, messageId: 'm', text: '我决定采用本地方案', truncated: false };
const result: InsightResult = { version: 1, perspective: 'reverse_thinking', generatedAt: timestamp,
  rangeStart: '2026-10-01T00:00:00.000Z', rangeEnd: '2026-10-25T00:00:00.000Z', scopeKind: 'personal_main',
  analyzedTurnCount: 1, analyzedSessionCount: 1, truncated: false, omittedTurnCount: 0, modelCallCount: 2, semanticCacheHit: false,
  cards: [{ id: 'c', title: '维护成本', explanation: '可能需要额外维护时间', nature: 'hypothesis',
    verificationQuestion: '每周需要多少维护时间？', supportingEventIds: ['event'], supportingReferences: [reference] }] };

function fixture() {
  let sessions = [session];
  let fingerprint = 'initial';
  const gate = createHistoryAnalysisTaskGate();
  const post = vi.fn((_message: WorkerMessage) => {});
  const readSource = vi.fn(async () => source);
  const generate = vi.fn(async (_input: InsightGenerateInput, context: InsightGenerationContext) => {
    context.onSourcesValidated([source]);
    context.onHistoryValidated({ rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, fingerprint });
    return result;
  });
  const controller = createInsightController({ listSessions: async () => sessions, taskGate: gate,
    post, readSource, historyFingerprint: async () => fingerprint, generate });
  return { controller, gate, post, readSource, generate,
    revoke: () => { sessions = []; }, editHistory: () => { fingerprint = 'edited'; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function finish(f: ReturnType<typeof fixture>) {
  f.controller.handle({ type: 'insight.generate', input: request });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'insight.completed' }) })));
}
async function read(f: ReturnType<typeof fixture>, requestId: string, entryId = 'e') {
  f.controller.handle({ type: 'insight.source', requestId, input: { requestId: request.requestId, sessionId: 's', entryId } });
  await tick();
  return f.post.mock.calls.find(([message]) => message.type === 'insight.source.result' && message.requestId === requestId)?.[0];
}

it('rejects a forged project before invoking the analyzer', async () => {
  const f = fixture();
  f.controller.handle({ type: 'insight.generate', input: { ...request, currentSessionId: 's', scope: { kind: 'project', workingDirectory: '/' } } });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'insight.failed' }) })));
  expect(f.generate).not.toHaveBeenCalled();
});

it('permits only one analysis across legacy map and insight, releasing the slot on cancellation', async () => {
  const f = fixture();
  let end!: (value: InsightResult) => void;
  f.generate.mockImplementation(() => new Promise(resolve => { end = resolve; }));
  f.controller.handle({ type: 'insight.generate', input: request });
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalled());
  const mapGenerate = vi.fn();
  const map = createConversationMapController({ listSessions: async () => [session], taskGate: f.gate,
    generate: mapGenerate, readSource: f.readSource, post: f.post });
  map.handle({ type: 'conversation-map.generate', input: { requestId: 'map', range: '30d', scope: request.scope } });
  expect(mapGenerate).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'conversation-map.failed', code: 'busy' }) }));
  f.controller.cancel(request.requestId);
  const release = f.gate.acquire();
  expect(release).toBeTypeOf('function');
  end(result); await tick();
  expect(f.post.mock.calls.some(([message]) => message.type === 'insight.event' && message.event.type === 'insight.completed')).toBe(false);
  // A cancelled task's finally must not release the newer owner's slot.
  expect(f.gate.acquire()).toBeUndefined();
  release?.();
});

it('rejects invented evidence, edited sources and invalidates subsequent source access', async () => {
  const f = fixture(); await finish(f);
  expect(await read(f, 'invented', 'invented')).toMatchObject({ result: { available: false } });
  expect(f.readSource).not.toHaveBeenCalled();
  expect(await read(f, 'good')).toMatchObject({ result: { available: true } });
  f.readSource.mockResolvedValue({ ...source, text: '编辑后的内容' });
  expect(await read(f, 'edited')).toMatchObject({ result: { available: false } });
  f.readSource.mockClear();
  expect(await read(f, 'again')).toMatchObject({ result: { available: false } });
  expect(f.readSource).not.toHaveBeenCalled();
});

it.each(['revoke', 'editHistory'] as const)('rechecks %s before displaying evidence', async change => {
  const f = fixture(); await finish(f); f[change]();
  expect(await read(f, 'changed')).toMatchObject({ result: { available: false } });
  expect(f.readSource).not.toHaveBeenCalled();
});

it('rejects results if history changes after generation and before publication', async () => {
  const f = fixture();
  f.generate.mockImplementation(async (_input, context) => {
    context.onSourcesValidated([source]);
    context.onHistoryValidated({ rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, fingerprint: 'initial' });
    f.editHistory(); return result;
  });
  f.controller.handle({ type: 'insight.generate', input: request });
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'insight.failed' }) })));
  expect(f.post.mock.calls.some(([message]) => message.type === 'insight.event' && message.event.type === 'insight.completed')).toBe(false);
});
