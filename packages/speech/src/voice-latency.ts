export const VOICE_LATENCY_EVENTS = [
  'record_end', 'asr_final', 'run_started', 'llm_first_token', 'assistant_final_commit',
  'tts_start', 'tts_ready', 'playback_started', 'playback_ended', 'stop_requested', 'playback_stopped',
  'user_ended', 'turn_complete', 'transcript_ready', 'first_speakable', 'tts_first_pcm'
] as const;
export type VoiceLatencyEvent = typeof VOICE_LATENCY_EVENTS[number];
export interface VoiceLatencyIdentity { captureId: string; generation: number }
export const VOICE_LATENCY_SPANS = {
  asrFinalMs: ['record_end', 'asr_final'],
  runDispatchMs: ['asr_final', 'run_started'],
  llmTtftMs: ['run_started', 'llm_first_token'],
  assistantCommitMs: ['llm_first_token', 'assistant_final_commit'],
  finalToTtsMs: ['assistant_final_commit', 'tts_start'],
  ttsReadyMs: ['tts_start', 'tts_ready'],
  legacyPlaybackStartMs: ['tts_ready', 'playback_started'],
  playbackMs: ['playback_started', 'playback_ended'],
  stopMs: ['stop_requested', 'playback_stopped'],
  recordToPlaybackMs: ['record_end', 'playback_started'],
  endpointMs: ['user_ended', 'turn_complete'],
  asrCommitMs: ['turn_complete', 'transcript_ready'],
  firstSpeakableMs: ['llm_first_token', 'first_speakable'],
  ttsFirstPcmMs: ['tts_start', 'tts_first_pcm'],
  playbackStartMs: ['tts_first_pcm', 'playback_started'],
  totalMs: ['user_ended', 'playback_started']
} as const satisfies Record<string, readonly [VoiceLatencyEvent, VoiceLatencyEvent]>;
export type VoiceLatencyMetric = keyof typeof VOICE_LATENCY_SPANS;
export interface VoiceLatencySummary { samples: number; p50Ms: number; p95Ms: number; meanMs: number }
interface Trace { generation: number; marks: Partial<Record<VoiceLatencyEvent, number>>; measured: Set<VoiceLatencyMetric> }
export interface VoiceLatencyRecorderOptions {
  now?: () => number;
  maxActiveTraces?: number;
  maxSamplesPerMetric?: number;
}

/** Bounded, process-local monotonic timing. Snapshots contain numeric aggregates
 * only: no transcript, text, audio, paths, or capture/run identities. */
export class VoiceLatencyRecorder {
  private readonly traces = new Map<string, Trace>();
  private readonly observations = new Map<VoiceLatencyMetric, number[]>();
  private readonly now: () => number;
  private readonly maxTraces: number;
  private readonly maxSamples: number;
  constructor(options: VoiceLatencyRecorderOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxTraces = options.maxActiveTraces ?? 128;
    this.maxSamples = options.maxSamplesPerMetric ?? 1000;
    if (![this.maxTraces, this.maxSamples].every(value => Number.isSafeInteger(value) && value > 0 && value <= 10_000)) throw new Error('invalid_voice_latency_limits');
  }
  begin(identity: VoiceLatencyIdentity): void {
    if (!identity.captureId || identity.captureId.length > 256 || !Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('invalid_voice_latency_identity');
    const current = this.traces.get(identity.captureId);
    if (current && current.generation >= identity.generation) return;
    if (!current && this.traces.size >= this.maxTraces) this.traces.delete(this.traces.keys().next().value!);
    this.traces.set(identity.captureId, { generation: identity.generation, marks: {}, measured: new Set() });
  }
  mark(identity: VoiceLatencyIdentity, event: VoiceLatencyEvent, atMs = this.now()): boolean {
    const trace = this.traces.get(identity.captureId);
    if (!trace || trace.generation !== identity.generation) return false;
    if (!VOICE_LATENCY_EVENTS.includes(event) || !Number.isFinite(atMs) || atMs < 0) throw new Error('invalid_voice_latency_mark');
    if (trace.marks[event] !== undefined) return false;
    trace.marks[event] = atMs;
    for (const name of Object.keys(VOICE_LATENCY_SPANS) as VoiceLatencyMetric[]) {
      if (trace.measured.has(name)) continue;
      const [start, end] = VOICE_LATENCY_SPANS[name];
      const from = trace.marks[start]; const to = trace.marks[end];
      if (from === undefined || to === undefined || to < from) continue;
      trace.measured.add(name);
      const values = this.observations.get(name) ?? [];
      values.push(to - from);
      if (values.length > this.maxSamples) values.shift();
      this.observations.set(name, values);
    }
    return true;
  }
  end(identity: VoiceLatencyIdentity): void {
    if (this.traces.get(identity.captureId)?.generation === identity.generation) this.traces.delete(identity.captureId);
  }
  snapshot(): { activeTraces: number; metrics: Partial<Record<VoiceLatencyMetric, VoiceLatencySummary>> } {
    const metrics: Partial<Record<VoiceLatencyMetric, VoiceLatencySummary>> = {};
    for (const [name, values] of this.observations) metrics[name] = summarizeVoiceLatency(values);
    return { activeTraces: this.traces.size, metrics };
  }
}

/** Nearest-rank percentiles so a small benchmark never hides its slowest p95. */
export function summarizeVoiceLatency(values: readonly number[]): VoiceLatencySummary {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid_voice_latency_samples');
  const ordered = [...values].sort((a, b) => a - b);
  return {
    samples: values.length, p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1]!,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!, meanMs: values.reduce((sum, value) => sum + value, 0) / values.length
  };
}
