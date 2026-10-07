import type { WorkerCommand } from '@desktop-agent/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionMetadataClient } from './session-client';
afterEach(() => vi.useRealTimers());
it('rejects failed sends without leaving a timer', async () => {
  vi.useFakeTimers();
  const client = new SessionMetadataClient(() => false);
  await expect(client.list()).rejects.toThrow('not available');
  expect(vi.getTimerCount()).toBe(0);
});
it('correlates replies and rejects pending requests on exit while allowing restart', async () => {
  const commands: Extract<WorkerCommand, { type: 'session.metadata' }>[] = [];
  const client = new SessionMetadataClient(command => { if (command.type === 'session.metadata') commands.push(command); return true; });
  const first = client.list(); const second = client.get('session');
  client.accept({ type: 'session.metadata.result', requestId: commands[1]!.requestId, ok: true, result: null });
  expect(await second).toBeNull();
  const rejected = expect(first).rejects.toThrow('exited'); client.close(); await rejected;
  const restarted = client.list();
  client.accept({ type: 'session.metadata.result', requestId: commands[0]!.requestId, ok: true, result: [] });
  client.accept({ type: 'session.metadata.result', requestId: commands[2]!.requestId, ok: true, result: [] });
  expect(await restarted).toEqual([]);
});
it('times out and safely ignores a late reply', async () => {
  vi.useFakeTimers(); let requestId = '';
  const client = new SessionMetadataClient(command => { if (command.type === 'session.metadata') requestId = command.requestId; return true; }, 50);
  const failed = expect(client.list()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(50); await failed;
  client.accept({ type: 'session.metadata.result', requestId, ok: true, result: [] });
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects malformed success responses', async () => {
  let requestId = '';
  const client = new SessionMetadataClient(command => { if (command.type === 'session.metadata') requestId = command.requestId; return true; });
  const failed = expect(client.list()).rejects.toThrow('Invalid');
  client.accept({ type: 'session.metadata.result', requestId, ok: true }); await failed;
});

it('permanent closing rejects new requests while ignoring late responses', async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  const client = new SessionMetadataClient(send);
  const pending = client.list();
  const failed = expect(pending).rejects.toThrow('runtime_closing');
  client.close(new Error('runtime_closing'), true); await failed;
  await expect(client.list()).rejects.toThrow('runtime_closing');
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
