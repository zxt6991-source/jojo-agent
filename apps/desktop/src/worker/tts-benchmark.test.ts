import { describe, expect, it } from 'vitest';
import type { RealtimeTtsProvider } from '@desktop-agent/speech';
import { runTtsBenchmark } from '../../../../scripts/tts-benchmark-runner';

function fixture(invalid: 'none' | 'identity' | 'empty' = 'none') {
  let clock = 0, sessions = 0, cancellations = 0;
  const provider: RealtimeTtsProvider = { capabilities: { textStreaming: false, audioStreaming: false, wordTimings: false }, async open(options) {
    sessions++; clock += 10; let cancelled = false;
    return { bufferedAudioMs: 0, async append() { clock += 20; }, async finish() { clock += 30; }, async cancel() { if (!cancelled) { cancellations++; clock += 5; cancelled = true; } }, async *audio() {
      if (cancelled || invalid === 'empty') return;
      clock += 40;
      yield { sessionId: invalid === 'identity' ? 'stale' : options.sessionId, generation: options.generation, segmentId: sessions === 10 ? 'recovery' : ['short', 'sentence', 'long', 'date', 'model', 'symbols', 'path', 'command'][sessions - 1]!, sequence: 1, codec: 'pcm16le', sampleRate: 24000, channels: 1, pcm: new Uint8Array(48000), segmentFrameOffset: 0, segmentFrames: 24000, final: true };
    } };
  } };
  return { provider, now: () => clock, cancelled: () => cancellations, waitBeforeCancel: async () => { clock += 50; } };
}
describe('TTS benchmark measurement boundaries', () => {
  it('includes startup, measures actual PCM, reports unitless RTF and post-cancel recovery', async () => {
    const f = fixture(), observed: string[] = [];
    const result = await runTtsBenchmark(f.provider, { iterations: 1, now: f.now, waitBeforeCancel: f.waitBeforeCancel, onUtteranceStart: event => { observed.push(event.category); } });
    expect(result.runs).toHaveLength(8); expect(result.runs[0]!.cold).toBe(true);
    expect(result.runs[0]!.firstPcmMs).toBe(100); expect(result.runs[0]!.totalMs).toBe(100);
    expect(result.warmFirstPcmMs.samples).toBe(7); expect(result.rtf.p95).toBe(0.1);
    expect(result.cancelLatencyMs).toBe(5); expect(result.postCancelRecovery.audioMs).toBe(1000); expect(f.cancelled()).toBe(10);
    expect(observed).toEqual(['short', 'sentence', 'long', 'date', 'model', 'symbols', 'path', 'command', 'cancel', 'recovery']);
  });
  it.each(['empty', 'identity'] as const)('fails on %s output instead of writing zero-success metrics', async invalid => {
    const f = fixture(invalid); await expect(runTtsBenchmark(f.provider, { iterations: 1, now: f.now })).rejects.toThrow(); expect(f.cancelled()).toBe(1);
  });
  it('rejects unbounded iterations before opening a provider', async () => {
    const f = fixture(); await expect(runTtsBenchmark(f.provider, { iterations: 100 })).rejects.toThrow('iterations'); expect(f.cancelled()).toBe(0);
  });
});
