import { describe, expect, it } from 'vitest';
import { PlaybackEngine } from './playback-engine';
import { evaluateSpeakerBargeInGate } from './aec-gate';
const chunk = (sequence: number, segmentId: string, final = false, frames = 480) => ({ sequence, segmentId, generation: 1, sampleRate: 24000, channels: 1 as const, format: 'pcm16le' as const,
  bytes: new Uint8Array(new Int16Array(frames).fill(16000).buffer), endOfSegment: final });
describe('worklet PCM playback', () => {
  it('resamples a continuous segment, advances only rendered frames, and ACKs a segment only after its final tail', () => {
    const engine = new PlaybackEngine(48000); engine.setGeneration(1);
    engine.enqueue(chunk(1, 'one')); const first = new Float32Array(128); engine.render(first);
    expect(first.some(value => value > 0)).toBe(true); expect(engine.drainCompletedSegments()).toEqual([]);
    engine.pause(); const before = engine.cursor().playedFrames; engine.render(first); expect(first.every(value => value === 0)).toBe(true); expect(engine.cursor().playedFrames).toBe(before);
    engine.resume(); engine.enqueue(chunk(2, 'one', true));
    while (engine.cursor().bufferedFrames) engine.render(first);
    expect(engine.drainCompletedSegments()).toEqual(['one']); expect(engine.cursor().playedFrames).toBe(1920);
    engine.render(first); expect(engine.cursor().playedFrames).toBe(1920);
  });
  it('ducks and resumes retained PCM; flush never advances heard frames or resurrects old audio', () => {
    const engine = new PlaybackEngine(24000); engine.setGeneration(1); engine.enqueue(chunk(1, 'one', true));
    const block = new Float32Array(128); engine.duck(); engine.render(block); expect(Math.max(...block)).toBeLessThan(0.1);
    engine.resume(); engine.render(block); expect(Math.max(...block)).toBeGreaterThan(0.3);
    const heard = engine.cursor().playedFrames; engine.flush({ generation: 0 }); expect(engine.cursor().bufferedFrames).toBeGreaterThan(0);
    engine.flush(); engine.render(block); expect(block.every(value => value === 0)).toBe(true); expect(engine.cursor().playedFrames).toBe(heard);
    engine.setGeneration(2); expect(() => engine.enqueue(chunk(2, 'late', true))).toThrow('stale');
  });
  it('rejects sequence loss and bounds its ring', () => {
    const engine = new PlaybackEngine(24000, 100); engine.setGeneration(1);
    expect(() => engine.enqueue(chunk(2, 'one'))).toThrow('sequence');
    expect(() => engine.enqueue(chunk(1, 'one', true, 3000))).toThrow('buffer_full');
    engine.enqueue(chunk(1, 'one', true)); expect(engine.cursor().bufferedFrames).toBeLessThanOrEqual(2400);
  });
});
it('requires a matching physical AEC report, beyond echoCancellation or synthetic replay', () => {
  const topology = { environmentKey: 'mac-speaker-volume-50', ownership: 'same-context' as const, echoCancellation: true };
  expect(evaluateSpeakerBargeInGate(topology).enabled).toBe(false);
  const report = { environmentKey: topology.environmentKey, measuredAt: Date.now(), source: 'physical-device' as const, tests: { playbackOnlyNoSpeechStart: true, userSpeechDetectedDuringPlayback: true, overlapAsrRecognizesUser: true } };
  expect(evaluateSpeakerBargeInGate(topology, report).enabled).toBe(true);
  expect(evaluateSpeakerBargeInGate({ ...topology, environmentKey: 'new-device' }, report).enabled).toBe(false);
});
