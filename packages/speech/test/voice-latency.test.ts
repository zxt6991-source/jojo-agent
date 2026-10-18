import { describe, expect, it } from 'vitest';

import { VoiceLatencyRecorder, summarizeVoiceLatency } from '../src/voice-latency.js';

describe('voice latency baseline', () => {
  it('measures baseline and streaming stages once with monotonic marks', () => {
    const recorder = new VoiceLatencyRecorder();
    const identity = { captureId: 'private-capture-id', generation: 1 };
    recorder.begin(identity);
    const events = {
      user_ended: 0, record_end: 10, turn_complete: 200, asr_final: 260, transcript_ready: 260,
      run_started: 300, llm_first_token: 500, first_speakable: 600, assistant_final_commit: 650,
      tts_start: 700, tts_ready: 1000, tts_first_pcm: 1010, playback_started: 1050,
      playback_ended: 2000, stop_requested: 2010, playback_stopped: 2030
    } as const;
    for (const [event, atMs] of Object.entries(events)) recorder.mark(identity, event as keyof typeof events, atMs);
    expect(recorder.mark(identity, 'playback_started', 2000)).toBe(false);
    const snapshot = recorder.snapshot();
    expect(snapshot.metrics.totalMs).toMatchObject({ samples: 1, p50Ms: 1050, p95Ms: 1050 });
    expect(snapshot.metrics.endpointMs?.p50Ms).toBe(200);
    expect(snapshot.metrics.llmTtftMs?.p50Ms).toBe(200);
    expect(snapshot.metrics.ttsFirstPcmMs?.p50Ms).toBe(310);
    expect(snapshot.metrics.stopMs?.p50Ms).toBe(20);
    expect(JSON.stringify(snapshot)).not.toContain('private-capture-id');
    recorder.end(identity);
    expect(recorder.snapshot().activeTraces).toBe(0);
  });

  it('rejects old generations and retains bounded samples and traces', () => {
    const recorder = new VoiceLatencyRecorder({ maxActiveTraces: 1, maxSamplesPerMetric: 2 });
    for (let generation = 1; generation <= 3; generation++) {
      const identity = { captureId: 'same', generation };
      recorder.begin(identity);
      recorder.mark(identity, 'tts_start', 0);
      recorder.mark(identity, 'tts_first_pcm', generation * 10);
    }
    expect(recorder.mark({ captureId: 'same', generation: 1 }, 'playback_started', 1)).toBe(false);
    expect(recorder.snapshot().metrics.ttsFirstPcmMs).toEqual({ samples: 2, p50Ms: 20, p95Ms: 30, meanMs: 25 });
    recorder.begin({ captureId: 'new', generation: 1 });
    expect(recorder.mark({ captureId: 'same', generation: 3 }, 'playback_started', 1)).toBe(false);
    expect(recorder.snapshot().activeTraces).toBe(1);
  });

  it('never invents a missing or negatively ordered span', () => {
    const recorder = new VoiceLatencyRecorder(); const identity = { captureId: 'one', generation: 1 };
    recorder.begin(identity); recorder.mark(identity, 'tts_ready', 100); recorder.mark(identity, 'tts_start', 200);
    expect(recorder.snapshot().metrics.ttsReadyMs).toBeUndefined();
    expect(() => recorder.mark(identity, 'playback_started', NaN)).toThrow('invalid_voice_latency_mark');
    expect(summarizeVoiceLatency([100, 200, 300, 400])).toEqual({ samples: 4, p50Ms: 200, p95Ms: 400, meanMs: 250 });
  });
});
