import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureChannel } from './capture-channel';
import { SpeechAudioFrameSchema, type SpeechCaptureHandle } from '@desktop-agent/contracts';

function fixture() {
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
  const failure = vi.fn();
  const channel = new CaptureChannel({ captureId: 'capture-1', generation: 3 }, port, failure);
  const ack = (sequence: number, generation = 3) => port.onmessage?.({ data: { type: 'ack', captureId: 'capture-1', generation, sequence } } as MessageEvent);
  return { port, failure, channel, ack };
}
afterEach(() => vi.useRealTimers());

describe('capture ACK window', () => {
  it('projects a real capture handle to the strict binary channel identity', () => {
    const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
    const handle: SpeechCaptureHandle = { captureId: 'capture-1', generation: 3, voiceTurnId: 'voice-1', sessionId: 'session-1', purpose: 'conversation' };
    const channel = new CaptureChannel(handle, port, vi.fn());
    channel.send(new Uint8Array(6_400)); channel.end();
    port.onmessage?.({ data: { type: 'ack', captureId: 'capture-1', generation: 3, sequence: 1 } } as MessageEvent);
    const frames = port.postMessage.mock.calls.map(([frame]) => frame);
    expect(frames.map(frame => frame.type)).toEqual(['audio', 'end']);
    for (const frame of frames) {
      expect(SpeechAudioFrameSchema.safeParse(frame).success).toBe(true);
      expect(frame).not.toHaveProperty('voiceTurnId'); expect(frame).not.toHaveProperty('sessionId'); expect(frame).not.toHaveProperty('purpose');
    }
    channel.close();
  });
  it('sends ordered chunks and end only after all preceding ACKs', () => {
    const { port, channel, ack } = fixture();
    channel.send(new Uint8Array(6_400)); channel.send(new Uint8Array(128)); channel.end();
    expect(port.postMessage.mock.calls.map(([value]) => value.type)).toEqual(['audio', 'audio']);
    ack(2); expect(port.postMessage).toHaveBeenCalledTimes(2);
    ack(1); expect(port.postMessage.mock.calls[2]?.[0]).toMatchObject({ type: 'end', lastSequence: 2, generation: 3 });
  });
  it('ignores stale and duplicate ACKs', () => {
    const { port, channel, ack } = fixture();
    channel.send(new Uint8Array(100)); channel.end(); ack(1, 2); ack(4);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    ack(1); ack(1); expect(port.postMessage).toHaveBeenCalledTimes(2);
  });
  it('aborts instead of dropping samples or growing beyond eight packets', () => {
    const { port, channel, failure } = fixture();
    for (let index = 0; index < 9; index += 1) channel.send(new Uint8Array(6_400));
    expect(port.postMessage).toHaveBeenCalledTimes(8);
    expect(port.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
    channel.end(); expect(port.postMessage).toHaveBeenCalledTimes(8);
  });
  it('cancels on a two-second missing ACK and clears all timers', () => {
    vi.useFakeTimers();
    const { channel, failure } = fixture();
    channel.send(new Uint8Array(6_400)); vi.advanceTimersByTime(1_999); expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(failure).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
