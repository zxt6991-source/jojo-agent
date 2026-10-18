import { describe, expect, it } from 'vitest';
import { completeReadingAudio } from './complete-reading';
import { createSilentWavFixture } from '../testing/speech-audio-fixture';

describe('one continuous WAV for a complete reading', () => {
  it('preserves ordered samples across every boundary and emits one correct WAV header', () => {
    const first = createSilentWavFixture(), second = createSilentWavFixture();
    first[44] = 11; second[44] = 22;
    const result = completeReadingAudio([first, second]);
    const view = new DataView(result.bytes.buffer);
    expect(view.getUint32(4, true)).toBe(result.bytes.length - 8);
    expect(view.getUint32(40, true)).toBe(first.length + second.length - 88);
    expect(result.bytes.subarray(44, first.length)).toEqual(first.subarray(44));
    expect(result.bytes.subarray(first.length)).toEqual(second.subarray(44));
    expect(result.durationMs).toBe(200);
  });
  it('refuses empty, incomplete or mismatched audio before any playback', () => {
    expect(() => completeReadingAudio([])).toThrow();
    expect(() => completeReadingAudio([createSilentWavFixture(), Uint8Array.of(1, 2)])).toThrow();
    const bad = createSilentWavFixture(); new DataView(bad.buffer).setUint32(24, 44100, true);
    expect(() => completeReadingAudio([createSilentWavFixture(), bad])).toThrow();
  });
});
