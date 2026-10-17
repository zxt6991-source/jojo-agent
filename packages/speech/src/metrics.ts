import { SpeechDiagnosticsSchema, type SpeechDiagnostics, type SpeechMetricEvent } from '@desktop-agent/contracts';

const add = (a: number, b = 0) => Math.min(Number.MAX_SAFE_INTEGER, a + (Number.isFinite(b) ? Math.max(0, b) : 0));
export class SpeechDiagnosticsCollector {
  private readonly value: SpeechDiagnostics;
  private readonly times = { asr: [] as number[], tts: [] as number[] };
  constructor(now = new Date()) {
    const timing = () => ({ requests: 0, completed: 0, failed: 0, cancelled: 0, meanMs: 0, p95Ms: 0, samples: 0 });
    this.value = { startedAt: now.toISOString(), asr: { ...timing(), audioMs: 0 },
      tts: { ...timing(), requestedChars: 0, audioBytes: 0, cacheHits: 0 } };
  }
  record(event: SpeechMetricEvent): void {
    const target = this.value[event.kind];
    if (event.outcome === 'cache_hit') { this.value.tts.cacheHits = add(this.value.tts.cacheHits, 1); return; }
    if (!event.providerRequested) return;
    target.requests = add(target.requests, 1);
    target[event.outcome] = add(target[event.outcome], 1);
    const times = this.times[event.kind];
    times.push(Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0);
    if (times.length > 100) times.shift();
    target.samples = times.length;
    target.meanMs = times.reduce((sum, value) => sum + value, 0) / times.length;
    target.p95Ms = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!;
    if (event.kind === 'asr') this.value.asr.audioMs = add(this.value.asr.audioMs, event.audioMs);
    else {
      this.value.tts.requestedChars = add(this.value.tts.requestedChars, event.requestedChars);
      this.value.tts.audioBytes = add(this.value.tts.audioBytes, event.audioBytes);
    }
  }
  snapshot(): SpeechDiagnostics { return SpeechDiagnosticsSchema.parse(this.value); }
}
