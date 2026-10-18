interface SegmentSpan { segmentId: string; frames: number; played: number; final: boolean }

/** A fixed allocation with bounded segment metadata. No AudioBufferSource per chunk. */
export class PlaybackRingBuffer {
  private readonly samples: Float32Array;
  private spans: SegmentSpan[] = [];
  private readOffset = 0;
  private writeOffset = 0;
  private size = 0;
  private segmentId: string | undefined;
  private segmentFrames = 0;
  private totalFrames = 0;
  private completed: string[] = [];

  constructor(readonly capacityFrames: number, private readonly maxSegments = 1_024) {
    if (!Number.isSafeInteger(capacityFrames) || capacityFrames < 1) throw new Error('invalid_playback_capacity');
    this.samples = new Float32Array(capacityFrames);
  }

  get bufferedFrames(): number { return this.size; }
  get freeFrames(): number { return this.capacityFrames - this.size; }
  get playedFrames(): number { return this.totalFrames; }
  get currentSegmentId(): string | undefined { return this.segmentId; }
  get segmentPlayedFrames(): number { return this.segmentFrames; }

  enqueue(segmentId: string, input: Float32Array, final = false): void {
    if (!segmentId || segmentId.length > 256) throw new Error('invalid_segment_id');
    if (input.length > this.freeFrames) throw new Error('playback_buffer_full');
    const last = this.spans.at(-1);
    if (!input.length) {
      if (final && last?.segmentId === segmentId) last.final = true;
      else if (final) this.completed.push(segmentId);
      return;
    }
    if (last?.segmentId !== segmentId && this.spans.length >= this.maxSegments) throw new Error('playback_segment_limit');
    for (const value of input) {
      this.samples[this.writeOffset] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.writeOffset = (this.writeOffset + 1) % this.capacityFrames;
    }
    this.size += input.length;
    if (last?.segmentId === segmentId) { last.frames += input.length; last.final = final; }
    else this.spans.push({ segmentId, frames: input.length, played: 0, final });
  }

  /** Writes zeros on underrun. Only consumed audio advances the heard cursor. */
  render(output: Float32Array, gain = 1): number {
    output.fill(0);
    const count = Math.min(output.length, this.size);
    for (let index = 0; index < count; index += 1) {
      const span = this.spans[0]!;
      if (this.segmentId !== span.segmentId) { this.segmentId = span.segmentId; this.segmentFrames = span.played; }
      output[index] = this.samples[this.readOffset]! * gain;
      this.readOffset = (this.readOffset + 1) % this.capacityFrames;
      this.size -= 1; this.totalFrames += 1; this.segmentFrames += 1; span.played += 1;
      if (span.played === span.frames) { this.spans.shift(); if (span.final) this.completed.push(span.segmentId); }
    }
    return count;
  }

  /** Retain the unplayed prefix through this segment; an unknown id is rejected. */
  flush(afterSegmentId?: string): void {
    if (afterSegmentId !== undefined) {
      const index = this.spans.findIndex(span => span.segmentId === afterSegmentId);
      if (index < 0) {
        if (this.segmentId !== afterSegmentId) throw new Error('unknown_playback_segment');
        this.clearQueued(); return;
      }
      this.spans = this.spans.slice(0, index + 1);
      this.size = this.spans.reduce((sum, span) => sum + span.frames - span.played, 0);
      this.writeOffset = (this.readOffset + this.size) % this.capacityFrames;
      return;
    }
    this.clearQueued();
  }

  reset(): void { this.clearQueued(); this.totalFrames = 0; this.segmentFrames = 0; this.segmentId = undefined; }
  drainCompletedSegments(): string[] { const result = this.completed; this.completed = []; return result; }
  private clearQueued(): void { this.spans = []; this.completed = []; this.size = 0; this.writeOffset = this.readOffset; }
}
