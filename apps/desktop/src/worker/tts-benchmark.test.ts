import { describe, expect, it, vi } from 'vitest';
import type { RealtimeTtsProvider } from '@desktop-agent/speech';
import { runTtsBenchmark, TTS_BENCHMARK_CORPUS } from '../../../../scripts/tts-benchmark-runner';

function fixture(invalid: 'none' | 'identity' | 'empty' = 'none') {
  let clock = 0, sessions = 0, cancellations = 0;
  const appended: { text: string; segmentId: string }[] = [];
  const provider: RealtimeTtsProvider = { capabilities: { textStreaming: false, audioStreaming: false, wordTimings: false }, async open(options) {
    sessions++; clock += 10; let cancelled = false, segmentId = '';
    let onAppend!: () => void;
    const ready = new Promise<void>(resolve => { onAppend = resolve; });
    return { bufferedAudioMs: 0, async append(text, input) { segmentId = input?.segmentId ?? ''; appended.push({ text, segmentId }); clock += 20; onAppend(); }, async finish() { clock += 30; }, async cancel() { if (!cancelled) { cancellations++; clock += 5; cancelled = true; onAppend(); } }, async *audio() {
      await ready;
      if (cancelled || invalid === 'empty') return;
      clock += 40;
      yield { sessionId: invalid === 'identity' ? 'stale' : options.sessionId, generation: options.generation, segmentId, sequence: 1, codec: 'pcm16le', sampleRate: 24000, channels: 1, pcm: new Uint8Array(48000), segmentFrameOffset: 0, segmentFrames: 24000, final: true };
    } };
  } };
  return { provider, now: () => clock, opened: () => sessions, appended, cancelled: () => cancellations, waitBeforeCancel: async () => { clock += 50; } };
}
describe('TTS benchmark measurement boundaries', () => {
  it('includes startup, measures actual PCM, reports unitless RTF and post-cancel recovery', async () => {
    const f = fixture(), observed: string[] = [], completed: string[] = [];
    const result = await runTtsBenchmark(f.provider, { iterations: 1, now: f.now, waitBeforeCancel: f.waitBeforeCancel,
      onUtteranceStart: event => { observed.push(event.category); }, onUtteranceComplete: event => { completed.push(event.category); } });
    expect(result.runs).toHaveLength(8); expect(result.runs[0]!.cold).toBe(true);
    expect(result.runs[0]!.firstPcmMs).toBe(100); expect(result.runs[0]!.totalMs).toBe(100);
    expect(result.warmFirstPcmMs?.samples).toBe(7); expect(result.rtf.p95).toBe(0.1);
    expect(result.cancelLatencyMs).toBe(5); expect(result.postCancelRecovery.audioMs).toBe(1000); expect(f.cancelled()).toBe(10);
    expect(observed).toEqual(['short', 'sentence', 'long', 'date', 'model', 'symbols', 'path', 'command', 'cancel', 'recovery']);
    expect(completed).toEqual(['short', 'sentence', 'long', 'date', 'model', 'symbols', 'path', 'command', 'recovery']);
  });
  it.each(['empty', 'identity'] as const)('fails on %s output instead of writing zero-success metrics', async invalid => {
    const f = fixture(invalid); await expect(runTtsBenchmark(f.provider, { iterations: 1, now: f.now })).rejects.toThrow(); expect(f.cancelled()).toBe(1);
  });
  it('rejects unbounded iterations before opening a provider', async () => {
    const f = fixture(); await expect(runTtsBenchmark(f.provider, { iterations: 100 })).rejects.toThrow('iterations'); expect(f.cancelled()).toBe(0);
  });
  it('isolates cancellation recovery to short warmup utterances and waits for the selected delay', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), observed: string[] = [], beforeCancel = vi.fn();
      const pending = runTtsBenchmark(f.provider, { iterations: 2, scenario: 'cancel-recovery', cancelProbeDelayMs: 600, now: f.now,
        onUtteranceStart: event => { observed.push(event.category); }, onBeforeCancel: beforeCancel });
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual(['short', 'short', 'cancel']);
      expect(f.cancelled()).toBe(2);
      await vi.advanceTimersByTimeAsync(599);
      expect(beforeCancel).not.toHaveBeenCalled();
      expect(f.cancelled()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(beforeCancel).toHaveBeenCalledOnce();
      expect(result.cancelProbeDelayMs).toBe(600);
      expect(result.runs.map(run => ({ category: run.category, cold: run.cold }))).toEqual([
        { category: 'short', cold: true }, { category: 'short', cold: false }
      ]);
      expect(result.warmFirstPcmMs?.samples).toBe(1);
      expect(result.postCancelRecovery.audioMs).toBe(1000);
      expect(observed).toEqual(['short', 'short', 'cancel', 'recovery']);
      expect(f.appended).toEqual([
        { text: TTS_BENCHMARK_CORPUS[0][1], segmentId: 'short' },
        { text: TTS_BENCHMARK_CORPUS[0][1], segmentId: 'short' },
        { text: TTS_BENCHMARK_CORPUS[2][1], segmentId: 'cancel' },
        { text: TTS_BENCHMARK_CORPUS[0][1], segmentId: 'recovery' }
      ]);
      expect(f.opened()).toBe(4);
      expect(f.cancelled()).toBe(4);
    } finally { vi.useRealTimers(); }
  });
  it('reports no warm samples for a single cancellation-recovery iteration while still measuring recovery', async () => {
    const f = fixture(), observed: string[] = [];
    const result = await runTtsBenchmark(f.provider, { iterations: 1, scenario: 'cancel-recovery', now: f.now,
      waitBeforeCancel: f.waitBeforeCancel, onUtteranceStart: event => { observed.push(event.category); } });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ category: 'short', cold: true, firstPcmMs: 100 });
    expect(result.warmFirstPcmMs).toBeNull();
    expect(result.cancelLatencyMs).toBe(5);
    expect(result.postCancelRecovery).toMatchObject({ firstPcmMs: 100, totalMs: 100, audioMs: 1000 });
    expect(observed).toEqual(['short', 'cancel', 'recovery']);
    expect(f.opened()).toBe(3);
    expect(f.cancelled()).toBe(3);
  });
  it.each([-1, 10_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid cancel delay %s before opening a provider', async cancelProbeDelayMs => {
    const f = fixture();
    await expect(runTtsBenchmark(f.provider, { iterations: 1, scenario: 'cancel-recovery', cancelProbeDelayMs })).rejects.toThrow('invalid_cancel_probe_delay');
    expect(f.opened()).toBe(0);
  });
  it.each([0, 10_000])('accepts the bounded cancel delay %s', async cancelProbeDelayMs => {
    const f = fixture();
    const result = await runTtsBenchmark(f.provider, { iterations: 2, scenario: 'cancel-recovery', cancelProbeDelayMs, now: f.now, waitBeforeCancel: f.waitBeforeCancel });
    expect(result.cancelProbeDelayMs).toBe(cancelProbeDelayMs);
    expect(result.runs).toHaveLength(2);
    expect(result.postCancelRecovery.audioMs).toBe(1000);
  });
});
