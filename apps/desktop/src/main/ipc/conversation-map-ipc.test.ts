import { afterEach, expect, it, vi } from 'vitest';
import { IPC, type WorkerCommand } from '@desktop-agent/contracts';
import type { IpcMainInvokeEvent } from 'electron';
import { ConversationMapIpc } from './conversation-map-ipc';

afterEach(() => vi.useRealTimers());
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const post = vi.fn((_command: WorkerCommand) => true);
  const emit = vi.fn();
  const assertTrusted = vi.fn();
  const host = new ConversationMapIpc({ post, emit, assertTrusted });
  host.register({ handle: (name, handler) => { handlers.set(name, handler); } });
  const invoke = (name: string, input: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input);
  return { host, post, emit, assertTrusted, invoke };
}
const request = { requestId: 'map-1', range: '30d', scope: { kind: 'personal_main' } };

it('checks trusted sender, strict inputs and prevents concurrent scans', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.assertTrusted.mockImplementationOnce(() => { throw new Error('Untrusted'); });
  expect(() => f.invoke(IPC.generateConversationMap, request)).toThrow('Untrusted');
  expect(f.post).not.toHaveBeenCalled();
  expect(() => f.invoke(IPC.generateConversationMap, { ...request, databasePath: '/tmp/x' })).toThrow();
  f.invoke(IPC.generateConversationMap, request);
  expect(() => f.invoke(IPC.generateConversationMap, { ...request, requestId: 'map-2' })).toThrow('已有');
  f.host.stop();
});

it('discards stale progress and completion after cancellation and permits retry', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.invoke(IPC.generateConversationMap, request);
  f.invoke(IPC.cancelConversationMap, { requestId: 'map-1' });
  f.host.accept({ type: 'conversation-map.event', event: { type: 'conversation-map.progress', requestId: 'map-1', phase: 'merging' } });
  expect(f.emit).toHaveBeenCalledTimes(1);
  expect(f.emit).toHaveBeenCalledWith({ type: 'conversation-map.cancelled', requestId: 'map-1' });
  f.invoke(IPC.generateConversationMap, { ...request, requestId: 'map-2' });
  vi.advanceTimersByTime(10 * 60_000);
  expect(f.post).toHaveBeenLastCalledWith({ type: 'conversation-map.cancel', requestId: 'map-2' });
  expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'conversation-map.failed' }));
});

it('resolves pending source lookups as unavailable when the process ends', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.invoke(IPC.getConversationMapSource, { requestId: 'map-1', sessionId: 's', entryId: 'e' });
  f.host.stop('worker exited');
  await expect(pending).resolves.toEqual({ available: false });
});

it('cleans timers and settles cancellation when the worker is already closing', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.post.mockImplementationOnce(() => { throw new Error('runtime_closing'); });
  expect(() => f.invoke(IPC.generateConversationMap, request)).toThrow('分析进程');
  f.invoke(IPC.generateConversationMap, request);
  f.post.mockImplementationOnce(() => { throw new Error('runtime_closing'); });
  expect(() => f.host.stop()).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});
