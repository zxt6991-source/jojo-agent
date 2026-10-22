import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamingAudioPlayer } from './stream-player';
import { isAudioHostAck, isAudioHostCommand, type AudioHostAck } from './ipc';

afterEach(() => vi.useRealTimers());
function setup() {
  const acks: AudioHostAck[] = [];
  const sources: { onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; buffer: unknown }[] = [];
  const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { currentTime: 10, state: 'running', destination: {}, createGain: () => gain,
    decodeAudioData: vi.fn(async () => ({ duration: 2 })), resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    createBufferSource: () => { const source = { onended: null as (() => void) | null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), buffer: undefined as unknown }; sources.push(source); return source; } };
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const player = new StreamingAudioPlayer({ createContext, acknowledge: ack => acks.push(ack) });
  const first = { type: 'play' as const, token: randomUUID(), generation: 4, stream: true as const, bytes: Uint8Array.of(1), volume: 0.3, format: 'wav' as const };
  const append = (index: number) => ({ type: 'append' as const, token: first.token, generation: first.generation, bytes: Uint8Array.of(2), index, format: 'wav' as const });
  const finish = (segments: number) => ({ type: 'finish' as const, token: first.token, generation: first.generation, segments });
  return { player, acks, sources, context, createContext, gain, first, append, finish };
}
it('schedules prefetched buffers on a single continuous timeline and waits for the real final ended', async () => {
  const h = setup(); h.player.receive(h.first); h.player.receive(h.append(1)); h.player.receive(h.finish(2));
  await vi.waitFor(() => expect(h.sources).toHaveLength(2));
  expect(h.createContext).toHaveBeenCalledOnce(); expect(h.gain.gain.value).toBe(0.3);
  expect(h.sources[0]!.start).toHaveBeenCalledWith(10.01); expect(h.sources[1]!.start).toHaveBeenCalledWith(12.01);
  h.sources[0]!.onended!();
  expect(h.acks.some(ack => ack.type === 'ended')).toBe(false);
  h.sources[1]!.onended!();
  expect(h.acks.map(ack => ack.type)).toEqual(['started', 'segment_ended', 'segment_ended', 'ended']);
  expect(h.context.close).toHaveBeenCalledOnce();
});
it('keeps an underflow open and resumes only when the next segment arrives', async () => {
  const h = setup(); h.player.receive(h.first); await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  h.sources[0]!.onended!(); expect(h.context.close).not.toHaveBeenCalled();
  h.context.currentTime = 20; h.player.receive(h.append(1));
  await vi.waitFor(() => expect(h.sources).toHaveLength(2));
  expect(h.sources[1]!.start).toHaveBeenCalledWith(20.01);
  h.sources[1]!.onended!(); expect(h.acks.some(ack => ack.type === 'ended')).toBe(false);
  h.player.receive(h.finish(2)); expect(h.acks.at(-1)?.type).toBe('ended');
});
it('bounds decoded and pending buffers and rejects out-of-order or premature finish commands', async () => {
  for (const invalid of ['overflow', 'index', 'finish']) {
    const h = setup(); h.player.receive(h.first);
    if (invalid === 'overflow') { h.player.receive(h.append(1)); h.player.receive(h.append(2)); h.player.receive(h.append(3)); }
    else if (invalid === 'index') h.player.receive(h.append(2));
    else h.player.receive(h.finish(2));
    await Promise.resolve();
    expect(h.acks).toEqual([expect.objectContaining({ type: 'error', reason: 'decode_failed' })]);
    expect(h.context.decodeAudioData).not.toHaveBeenCalled();
  }
});
it('ignores stale callbacks and a decode that completes after cancellation', async () => {
  const h = setup(); let resolve!: (value: { duration: number }) => void;
  h.context.decodeAudioData.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.player.receive(h.first); await Promise.resolve();
  h.player.receive({ type: 'stop', token: h.first.token }); resolve({ duration: 1 });
  await Promise.resolve(); await Promise.resolve(); expect(h.sources).toHaveLength(0); expect(h.acks).toEqual([]);
  const second = { ...h.first, token: randomUUID() }; h.player.receive(second);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const late = h.sources[0]!.onended!; h.player.receive({ type: 'stop', token: second.token });
  const before = h.acks.length; late(); expect(h.acks).toHaveLength(before);
});
it.each(['decode', 'device', 'autoplay'] as const)('reports %s failure without successful completion', async kind => {
  const h = setup();
  if (kind === 'decode') h.context.decodeAudioData.mockRejectedValueOnce(new Error('corrupt'));
  if (kind === 'autoplay') { h.context.state = 'suspended'; h.context.resume.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError')); }
  h.player.receive(h.first);
  if (kind === 'device') h.player.outputDeviceChanged();
  await vi.waitFor(() => expect(h.acks.at(-1)?.type).toBe('error'));
  expect(h.acks.at(-1)).toMatchObject({ reason: kind === 'decode' ? 'decode_failed' : kind === 'device' ? 'output_device_changed' : 'autoplay_denied' });
  expect(h.acks.some(ack => ack.type === 'ended')).toBe(false);
});
it('strictly bounds the private stream wire and consumed receipts', () => {
  const h = setup(); expect(isAudioHostCommand(h.first)).toBe(true);
  expect(isAudioHostCommand(h.append(1))).toBe(true); expect(isAudioHostCommand(h.finish(2))).toBe(true);
  expect(isAudioHostCommand({ ...h.first, complete: true })).toBe(false);
  expect(isAudioHostCommand(h.append(0))).toBe(false); expect(isAudioHostCommand(h.append(128))).toBe(false);
  expect(isAudioHostCommand({ ...h.append(1), bytes: new Uint8Array(8 * 1024 * 1024 + 1) })).toBe(false);
  expect(isAudioHostCommand({ ...h.finish(1), path: '/private/file' })).toBe(false);
  expect(isAudioHostAck({ type: 'segment_ended', token: h.first.token, generation: 4, index: 0 })).toBe(true);
  expect(isAudioHostAck({ type: 'segment_ended', token: h.first.token, generation: 4, index: -1 })).toBe(false);
});
