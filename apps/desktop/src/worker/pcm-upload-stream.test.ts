import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPEECH_LIMITS } from '@desktop-agent/contracts';
import { PcmUploadStream } from './pcm-upload-stream.js';

class Port extends EventEmitter {
  sent: unknown[] = []; closed = false;
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; this.emit('close'); }
  send(value: unknown) { this.emit('message', { data: value }); }
}
const binding = { captureId: 'capture', generation: 2 };
const audio = (sequence: number, length = 6400) => ({ type: 'audio', ...binding, sequence, bytes: new Uint8Array(length) });
const end = (lastSequence: number) => ({ type: 'end', ...binding, lastSequence });
function harness() { const port = new Port(); const onEnd = vi.fn(); const onFailure = vi.fn(); const stream = new PcmUploadStream(port, binding, { onEnd, onFailure }); stream.activate(); return { port, stream, onEnd, onFailure }; }
afterEach(() => vi.useRealTimers());

describe('independent bounded PCM upload port', () => {
  it('ACKs consumed chunks in order and waits for all chunks before the end of the iterator', async () => {
    const { port, stream, onEnd } = harness(); const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next(); port.send(audio(1)); await first;
    expect(port.sent).toEqual([]); port.send(audio(2, 32)); port.send(end(2)); expect(onEnd).toHaveBeenCalledOnce();
    expect((await iterator.next()).value).toHaveLength(32); expect(port.sent).toEqual([{ type: 'ack', ...binding, sequence: 1 }]);
    expect(await iterator.next()).toEqual({ value: undefined, done: true }); expect(stream.finished).toBe(true);
    expect(port.sent).toEqual([{ type: 'ack', ...binding, sequence: 1 }, { type: 'ack', ...binding, sequence: 2 }]); stream.dispose(); expect(port.closed).toBe(true);
  });
  it.each([
    { ...audio(1), captureId: 'wrong' }, { ...audio(1), generation: 1 }, audio(2), audio(1, 3),
    audio(1, SPEECH_LIMITS.maxChunkBytes + 2), end(0), { ...audio(1), unexpected: true }
  ])('rejects malformed, unbound, oversized or missing PCM without an ACK', async (frame) => {
    const { port, stream, onFailure } = harness(); const next = stream[Symbol.asyncIterator]().next();
    const rejected = expect(next).rejects.toMatchObject({ code: 'invalid_audio' }); port.send(frame); await rejected;
    expect(port.sent).toEqual([]); expect(port.closed).toBe(true); expect(onFailure).toHaveBeenCalledOnce();
  });
  it('rejects a mismatching lastSequence and audio after the end marker', () => {
    const first = harness(); first.port.send(audio(1)); first.port.send(end(0)); expect(first.stream.error?.code).toBe('invalid_audio');
    const second = harness(); second.port.send(audio(1)); second.port.send(end(1)); second.port.send(audio(2)); expect(second.stream.error?.code).toBe('invalid_audio');
  });
  it('cancels the ninth unacknowledged chunk and releases the queue', () => {
    const { port, stream, onFailure } = harness(); for (let sequence = 1; sequence <= 9; sequence++) port.send(audio(sequence));
    expect(stream.error?.code).toBe('invalid_audio'); expect(port.closed).toBe(true); expect(onFailure).toHaveBeenCalledOnce();
  });
  it('times out an unacknowledged in-flight chunk after two seconds', async () => {
    vi.useFakeTimers(); const { port, stream, onFailure } = harness(); const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next(); port.send(audio(1)); await next;
    await vi.advanceTimersByTimeAsync(2000); expect(onFailure).toHaveBeenCalledOnce(); expect(stream.error?.code).toBe('timeout');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'timeout' }); expect(port.closed).toBe(true);
  });
  it('enforces the cumulative PCM limit while consuming normal chunks', async () => {
    const { port, stream } = harness(); const iterator = stream[Symbol.asyncIterator]();
    for (let sequence = 1; sequence <= 301; sequence++) {
      port.send(audio(sequence)); await iterator.next();
    }
    const next = iterator.next(); const rejected = expect(next).rejects.toMatchObject({ code: 'invalid_audio' });
    port.send(audio(302, 2)); await rejected; expect(stream.bytes).toBe(SPEECH_LIMITS.captureBytes);
  });
  it('copies accepted bytes and closes on sender cancellation', async () => {
    const { port, stream } = harness(); const frame = audio(1, 2); frame.bytes[0] = 5; port.send(frame); frame.bytes[0] = 99;
    const iterator = stream[Symbol.asyncIterator](); expect((await iterator.next()).value?.[0]).toBe(5);
    port.send({ type: 'cancel', ...binding }); await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' }); expect(port.closed).toBe(true);
  });
});
