import { SPEECH_LIMITS, type SpeechCaptureHandle } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechStreamBridge, type MainAudioPort } from './speech-stream';

class FakePort implements MainAudioPort {
  private listener: (event: { data: unknown }) => void = () => undefined;
  start = vi.fn(); postMessage = vi.fn(); close = vi.fn();
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  receive(data: unknown) { this.listener({ data }); }
}
const bridges: SpeechStreamBridge[] = [];
afterEach(() => { bridges.splice(0).forEach((bridge) => bridge.close()); vi.useRealTimers(); });
function setup() {
  const handle: SpeechCaptureHandle = { captureId: 'capture-one', voiceTurnId: 'turn-one', sessionId: 'session-one', generation: 7, purpose: 'conversation' };
  const renderer = new FakePort(), worker = new FakePort(), fail = vi.fn();
  let now = 0;
  const bridge = new SpeechStreamBridge(handle, renderer, worker, fail, () => now); bridges.push(bridge);
  const identity = { captureId: handle.captureId, generation: handle.generation };
  const audio = (sequence: number, byteLength: number = SPEECH_LIMITS.pcmChunkBytes) => ({ type: 'audio' as const, ...identity, sequence, bytes: new Uint8Array(byteLength) });
  const ack = (sequence: number) => ({ type: 'ack' as const, ...identity, sequence });
  const end = (lastSequence: number) => ({ type: 'end' as const, ...identity, lastSequence });
  const expectClosed = () => { expect(renderer.close).toHaveBeenCalledOnce(); expect(worker.close).toHaveBeenCalledOnce(); expect(fail).toHaveBeenCalledOnce(); };
  return { handle, renderer, worker, fail, bridge, audio, ack, end, identity, expectClosed, setNow: (value: number) => { now = value; } };
}
describe('dedicated Main PCM bridge', () => {
  it('starts both ports, forwards ordered chunks/end, and relays ordered Worker ACKs', () => {
    const { renderer, worker, fail, audio, ack, end } = setup();
    expect(renderer.start).toHaveBeenCalledOnce(); expect(worker.start).toHaveBeenCalledOnce();
    const first = audio(1), second = audio(2, 100);
    renderer.receive(first); worker.receive(ack(1)); renderer.receive(second); renderer.receive(end(2));
    // End travels on the same channel after all bytes; Worker may ACK the final
    // audio only after Main has already forwarded that ordered end marker.
    worker.receive(ack(2));
    expect(worker.postMessage.mock.calls.map((call) => call[0])).toEqual([first, second, end(2)]);
    expect(renderer.postMessage.mock.calls.map((call) => call[0])).toEqual([ack(1), ack(2)]);
    expect(fail).not.toHaveBeenCalled();
  });
  it.each(['gap', 'duplicate', 'old_capture', 'old_generation', 'oversized', 'odd_pcm', 'empty_pcm', 'extra_field', 'base64'])('rejects %s audio before forwarding it', (kind) => {
    const { renderer, worker, audio, expectClosed } = setup();
    let frame: unknown = audio(1);
    if (kind === 'gap') frame = audio(2);
    if (kind === 'duplicate') renderer.receive(audio(1));
    if (kind === 'old_capture') frame = { ...audio(1), captureId: 'capture-other' };
    if (kind === 'old_generation') frame = { ...audio(1), generation: 6 };
    if (kind === 'oversized') frame = audio(1, SPEECH_LIMITS.maxChunkBytes + 2);
    if (kind === 'odd_pcm') frame = audio(1, 3);
    if (kind === 'empty_pcm') frame = audio(1, 0);
    if (kind === 'extra_field') frame = { ...audio(1), path: '/private/audio.pcm' };
    if (kind === 'base64') frame = { ...audio(1), bytes: 'base64-audio' };
    const count = worker.postMessage.mock.calls.length;
    renderer.receive(frame); expect(worker.postMessage).toHaveBeenCalledTimes(count); expectClosed();
    renderer.receive(audio(3)); expect(worker.postMessage).toHaveBeenCalledTimes(count); expectClosed();
  });
  it('accepts the exact cumulative PCM limit, then rejects one additional sample', () => {
    const { renderer, worker, fail, audio, ack, expectClosed } = setup();
    let bytes = 0, sequence = 0;
    while (bytes < SPEECH_LIMITS.captureBytes) {
      const size = Math.min(SPEECH_LIMITS.maxChunkBytes, SPEECH_LIMITS.captureBytes - bytes);
      renderer.receive(audio(++sequence, size)); worker.receive(ack(sequence)); bytes += size;
    }
    expect(fail).not.toHaveBeenCalled();
    const count = worker.postMessage.mock.calls.length;
    renderer.receive(audio(sequence + 1, 2)); expect(worker.postMessage).toHaveBeenCalledTimes(count); expectClosed();
  });
  it.each(['empty', 'incorrect_last_sequence', 'duplicate_end', 'audio_after_end'])('rejects %s end flow', (kind) => {
    const { renderer, worker, audio, end, expectClosed } = setup();
    if (kind === 'empty') renderer.receive(end(0));
    else {
      renderer.receive(audio(1));
      if (kind === 'incorrect_last_sequence') renderer.receive(end(0));
      else { renderer.receive(end(1)); renderer.receive(kind === 'duplicate_end' ? end(1) : audio(2)); }
    }
    expectClosed();
    expect(worker.postMessage.mock.calls.filter((call) => (call[0] as { type: string }).type === 'end')).toHaveLength(kind === 'duplicate_end' || kind === 'audio_after_end' ? 1 : 0);
  });
  it('allows 8 outstanding chunks, rejects a ninth, and never silently drops a sample', () => {
    const { renderer, worker, audio, fail, expectClosed } = setup();
    for (let sequence = 1; sequence <= 8; sequence++) renderer.receive(audio(sequence));
    expect(worker.postMessage).toHaveBeenCalledTimes(8); expect(fail).not.toHaveBeenCalled();
    renderer.receive(audio(9)); expect(worker.postMessage).toHaveBeenCalledTimes(8); expectClosed();
  });
  it('reopens one window slot after an ordered ACK', () => {
    const { renderer, worker, audio, ack, fail } = setup();
    for (let sequence = 1; sequence <= 8; sequence++) renderer.receive(audio(sequence));
    worker.receive(ack(1)); renderer.receive(audio(9));
    expect(worker.postMessage).toHaveBeenCalledTimes(9); expect(fail).not.toHaveBeenCalled();
  });
  it.each(['not_pending', 'gap', 'duplicate', 'old_capture', 'old_generation', 'extra_field'])('rejects %s Worker ACK and closes both ends', (kind) => {
    const { renderer, worker, audio, ack, expectClosed } = setup();
    let frame: unknown = ack(1);
    if (kind !== 'not_pending') { renderer.receive(audio(1)); renderer.receive(audio(2)); }
    if (kind === 'gap') frame = ack(2);
    if (kind === 'duplicate') worker.receive(ack(1));
    if (kind === 'old_capture') frame = { ...ack(1), captureId: 'capture-other' };
    if (kind === 'old_generation') frame = { ...ack(1), generation: 6 };
    if (kind === 'extra_field') frame = { ...ack(1), bytes: new Uint8Array(2) };
    const count = renderer.postMessage.mock.calls.length;
    worker.receive(frame); expect(renderer.postMessage).toHaveBeenCalledTimes(count); expectClosed();
  });
  it('cancels exactly once after 2 seconds of unacknowledged backlog', () => {
    vi.useFakeTimers();
    const { renderer, worker, audio, fail, setNow, expectClosed } = setup();
    renderer.receive(audio(1)); setNow(1999); vi.advanceTimersByTime(1900);
    expect(fail).not.toHaveBeenCalled();
    setNow(2000); vi.advanceTimersByTime(100); expectClosed();
    setNow(4000); vi.advanceTimersByTime(2000); expectClosed();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });
  it('checks the oldest remaining chunk after earlier ACKs and has no timeout without backlog', () => {
    vi.useFakeTimers();
    const { renderer, worker, audio, ack, fail, setNow } = setup();
    renderer.receive(audio(1)); setNow(500); renderer.receive(audio(2)); worker.receive(ack(1));
    setNow(2499); vi.advanceTimersByTime(100); expect(fail).not.toHaveBeenCalled();
    worker.receive(ack(2)); setNow(100_000); vi.advanceTimersByTime(5000); expect(fail).not.toHaveBeenCalled();
  });
  it('forwards explicit cancellation then closes, ignores subsequent frames and clears its watchdog', () => {
    vi.useFakeTimers();
    const { renderer, worker, bridge, audio, ack, identity, expectClosed, setNow } = setup();
    renderer.receive(audio(1)); renderer.receive({ type: 'cancel', ...identity }); expectClosed();
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'cancel', ...identity });
    renderer.receive(audio(2)); worker.receive(ack(1)); bridge.close();
    setNow(100_000); vi.advanceTimersByTime(5000); expectClosed();
    expect(worker.postMessage).toHaveBeenCalledTimes(2); expect(renderer.postMessage).not.toHaveBeenCalled();
  });
  it('supports an idempotent owner close without reporting a protocol failure', () => {
    const { bridge, renderer, worker, fail, audio } = setup(); bridge.close(); bridge.close(); renderer.receive(audio(1));
    expect(renderer.close).toHaveBeenCalledOnce(); expect(worker.close).toHaveBeenCalledOnce(); expect(fail).not.toHaveBeenCalled();
  });
});
