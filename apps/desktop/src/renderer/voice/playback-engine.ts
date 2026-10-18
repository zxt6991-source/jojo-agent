import { PcmResampler } from '../audio/pcm';
import { PlaybackRingBuffer } from './playback-ring-buffer';
import type { PlaybackCursor, PlaybackFlushOptions, VoicePcmChunk } from './types';

/** Worklet-safe playback state and DSP, also used by deterministic replay tests. */
export class PlaybackEngine {
  private readonly ring: PlaybackRingBuffer;
  private generation = 0;
  private lastSequence = 0;
  private paused = false;
  private gain = 1;
  private volume = 1;
  private source: { segmentId: string; sampleRate: number; resampler: PcmResampler } | undefined;
  private completedSegmentId: string | undefined;

  constructor(readonly sampleRate: number, capacityMs = 10_000) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error('unsupported_sample_rate');
    if (!Number.isFinite(capacityMs) || capacityMs < 100 || capacityMs > 30_000) throw new Error('invalid_playback_capacity');
    this.ring = new PlaybackRingBuffer(Math.ceil(sampleRate * capacityMs / 1_000));
  }

  setGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < this.generation) throw new Error('stale_playback_generation');
    if (generation === this.generation) return;
    this.generation = generation; this.lastSequence = 0; this.source = undefined;
    this.completedSegmentId = undefined; this.paused = false; this.gain = 1; this.ring.reset();
  }

  enqueue(chunk: VoicePcmChunk): void {
    if (chunk.generation !== this.generation) throw new Error('stale_playback_generation');
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== this.lastSequence + 1) throw new Error('playback_sequence_gap');
    if (!chunk.segmentId || chunk.segmentId.length > 256 || chunk.format !== 'pcm16le' || chunk.channels !== 1 ||
      !Number.isFinite(chunk.sampleRate) || chunk.sampleRate < 8_000 || chunk.sampleRate > 192_000 ||
      !(chunk.bytes instanceof Uint8Array) || !chunk.bytes.length || chunk.bytes.length % 2 || chunk.bytes.length > 256 * 1_024) throw new Error('invalid_playback_pcm');
    if (this.completedSegmentId === chunk.segmentId) throw new Error('playback_segment_finished');
    // Reserve worst-case resampler tail before mutating source state, so overflow is retryable.
    const reserve = Math.ceil(chunk.bytes.length / 2 * this.sampleRate / chunk.sampleRate) + Math.ceil(98 * this.sampleRate / Math.min(chunk.sampleRate, this.source?.sampleRate ?? chunk.sampleRate));
    if (reserve > this.ring.freeFrames) throw new Error('playback_buffer_full');
    if (this.source && (this.source.segmentId !== chunk.segmentId || this.source.sampleRate !== chunk.sampleRate)) {
      this.ring.enqueue(this.source.segmentId, this.source.resampler.finish(), true); this.source = undefined;
    }
    this.source ??= { segmentId: chunk.segmentId, sampleRate: chunk.sampleRate, resampler: new PcmResampler(chunk.sampleRate, this.sampleRate) };
    const view = new DataView(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    const samples = new Float32Array(chunk.bytes.length / 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
    this.ring.enqueue(chunk.segmentId, this.source.resampler.push(samples));
    if (chunk.endOfSegment) {
      this.ring.enqueue(chunk.segmentId, this.source.resampler.finish(), true); this.source = undefined; this.completedSegmentId = chunk.segmentId;
    }
    this.lastSequence = chunk.sequence;
  }

  duck(gain = 0.15): void { this.gain = Math.max(0.01, Math.min(1, Number.isFinite(gain) ? gain : 0.15)); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.gain = 1; }
  setVolume(gain: number): void { if (!Number.isFinite(gain) || gain < 0 || gain > 1) throw new Error('invalid_volume'); this.volume = gain; }
  flush(options: PlaybackFlushOptions = {}): void {
    if (options.generation !== undefined && options.generation !== this.generation) return;
    this.ring.flush(options.afterSegmentId);
    // A partial segment can still have filter look-ahead. Never let it resurrect after flush.
    this.source = undefined;
  }
  stop(): void { this.flush(); this.paused = false; this.gain = 1; }
  render(output: Float32Array): number { if (this.paused) { output.fill(0); return 0; } return this.ring.render(output, this.gain * this.volume); }
  drainCompletedSegments(): string[] { return this.ring.drainCompletedSegments(); }
  cursor(): PlaybackCursor {
    return { generation: this.generation, ...(this.ring.currentSegmentId ? { segmentId: this.ring.currentSegmentId } : {}),
      playedFrames: this.ring.playedFrames, playedMs: this.ring.playedFrames / this.sampleRate * 1_000,
      segmentPlayedFrames: this.ring.segmentPlayedFrames, bufferedFrames: this.ring.bufferedFrames, sampleRate: this.sampleRate,
      state: this.paused ? 'paused' : this.ring.bufferedFrames ? this.gain < 1 ? 'ducked' : 'playing' : 'idle' };
  }
}
