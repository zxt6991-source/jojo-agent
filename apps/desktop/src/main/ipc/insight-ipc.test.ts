import { afterEach, expect, it, vi } from 'vitest';
import { IPC, type WorkerCommand } from '@desktop-agent/contracts';
import type { IpcMainInvokeEvent } from 'electron';
import { InsightIpc } from './insight-ipc';
import { ConversationMapIpc } from './conversation-map-ipc';

afterEach(() => vi.useRealTimers());
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const post = vi.fn((_command: WorkerCommand) => true);
  const emit = vi.fn();
  const assertTrusted = vi.fn();
  const otherAnalysisActive = vi.fn(() => false);
  const host = new InsightIpc({ post, emit, assertTrusted, otherAnalysisActive });
  host.register({ handle: (name, handler) => { handlers.set(name, handler); } });
  const invoke = (name: string, input: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input);
  return { host, post, emit, assertTrusted, invoke, otherAnalysisActive };
}
const request = { requestId: 'map-1', range: '30d', perspective: 'reverse_thinking', scope: { kind: 'personal_main' } };

it('checks trusted sender, strict inputs and prevents concurrent scans', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.assertTrusted.mockImplementationOnce(() => { throw new Error('Untrusted'); });
  expect(() => f.invoke(IPC.generateInsight, request)).toThrow('Untrusted');
  expect(f.post).not.toHaveBeenCalled();
  expect(() => f.invoke(IPC.generateInsight, { ...request, databasePath: '/tmp/x' })).toThrow();
  f.invoke(IPC.generateInsight, request);
  expect(() => f.invoke(IPC.generateInsight, { ...request, requestId: 'map-2' })).toThrow('已有');
  f.host.stop();
});

it('discards stale progress and completion after cancellation and permits retry', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.invoke(IPC.generateInsight, request);
  f.invoke(IPC.cancelInsight, { requestId: 'map-1' });
  f.host.accept({ type: 'insight.event', event: { type: 'insight.progress', requestId: 'map-1', phase: 'analyzing' } });
  expect(f.emit).toHaveBeenCalledTimes(1);
  expect(f.emit).toHaveBeenCalledWith({ type: 'insight.cancelled', requestId: 'map-1' });
  f.invoke(IPC.generateInsight, { ...request, requestId: 'map-2' });
  vi.advanceTimersByTime(10 * 60_000);
  expect(f.post).toHaveBeenLastCalledWith({ type: 'insight.cancel', requestId: 'map-2' });
  expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'insight.failed' }));
});

it('resolves pending source lookups as unavailable when the process ends', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.invoke(IPC.getInsightSource, { requestId: 'map-1', sessionId: 's', entryId: 'e' });
  f.host.stop('worker exited');
  await expect(pending).resolves.toEqual({ available: false });
});

it('cleans timers and settles cancellation when the worker is already closing', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.post.mockImplementationOnce(() => { throw new Error('runtime_closing'); });
  expect(() => f.invoke(IPC.generateInsight, request)).toThrow('分析进程');
  f.invoke(IPC.generateInsight, request);
  f.post.mockImplementationOnce(() => { throw new Error('runtime_closing'); });
  expect(() => f.host.stop()).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

it('blocks an insight while a conversation map is active', () => {
  const f = fixture();
  f.otherAnalysisActive.mockReturnValue(true);
  expect(() => f.invoke(IPC.generateInsight, request)).toThrow('已有');
  expect(f.post).not.toHaveBeenCalled();
  expect(f.host.isBusy).toBe(false);
});

it('shares the analysis slot with the compatible conversation map API in both directions', () => {
  vi.useFakeTimers();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const post = vi.fn(() => true);
  const insights: InsightIpc = new InsightIpc({ post, emit: vi.fn(), assertTrusted: vi.fn(), otherAnalysisActive: () => maps.isBusy });
  const maps: ConversationMapIpc = new ConversationMapIpc({ post, emit: vi.fn(), assertTrusted: vi.fn(), otherAnalysisActive: () => insights.isBusy });
  const ipc = { handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => { handlers.set(name, handler); } };
  insights.register(ipc); maps.register(ipc);
  const invoke = (name: string, input: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input);
  const mapRequest = { requestId: 'map', range: '30d', scope: { kind: 'personal_main' } };
  invoke(IPC.generateInsight, request);
  expect(() => invoke(IPC.generateConversationMap, mapRequest)).toThrow('已有');
  insights.stop();
  invoke(IPC.generateConversationMap, mapRequest);
  expect(() => invoke(IPC.generateInsight, request)).toThrow('已有');
  maps.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds concurrent source lookups and settles timeouts', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const input = { requestId: 'map-1', sessionId: 's', entryId: 'e' };
  const pending = Array.from({ length: 24 }, () => f.invoke(IPC.getInsightSource, input));
  expect(() => f.invoke(IPC.getInsightSource, input)).toThrow('出处请求过多');
  vi.advanceTimersByTime(15_000);
  await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 24 }, () => ({ available: false })));
  expect(vi.getTimerCount()).toBe(0);
});
