import type { VoiceTextPhrase } from './voice-text-projector';

export interface VoiceChunkSchedulerOptions {
  firstChunkDeadlineMs?: number; lowBufferMs?: number; highBufferMs?: number; maxChars?: number;
  coalesceMs?: number; minChars?: number;
}
/** Later chunks follow consumption. A deadline never splits an unsafe parser
 * fragment: the projector must first release a complete speakable phrase. */
export class VoiceChunkScheduler {
  private pending: VoiceTextPhrase[] = [];
  private first = true;
  private firstAt: number | undefined;
  private pendingAt: number | undefined;
  constructor(private readonly options: VoiceChunkSchedulerOptions = {}) {}
  /** Start the first phrase deadline at the first public token, including time
   * already spent waiting for the projector to release a safe boundary. */
  start(now: number): void { this.firstAt ??= now; }
  append(phrases: VoiceTextPhrase[], now: number): void {
    if (phrases.length && this.firstAt === undefined) this.firstAt = now;
    if (phrases.length && !this.pending.length) this.pendingAt = now;
    this.pending.push(...phrases);
    if (this.pending.reduce((sum, phrase) => sum + phrase.text.length, 0) > 20_000) throw new Error('voice_chunk_backpressure');
  }
  take(now: number, bufferedMs: number, final = false): VoiceTextPhrase | undefined {
    if (!Number.isFinite(bufferedMs) || bufferedMs < 0) throw new Error('invalid_voice_buffer');
    if (!this.pending.length) return undefined;
    if (!final && !this.first && bufferedMs > (this.options.highBufferMs ?? 1500)) return undefined;
    const deadline = this.first && now - (this.firstAt ?? now) >= (this.options.firstChunkDeadlineMs ?? 400);
    if (!final && !this.first && bufferedMs >= (this.options.lowBufferMs ?? 500) && this.pending.length < 2) return undefined;
    const maxChars = this.options.maxChars ?? 180;
    // Give a short acknowledgement time to acquire the sentence that follows.
    // All available phrases then share one synthesis and its prosodic context.
    const age = now - (this.pendingAt ?? now);
    if (!final && this.pending.length === 1 && this.pending[0]!.text.length < (this.options.minChars ?? 24)
      && !deadline && age < (this.first ? this.options.firstChunkDeadlineMs ?? 400 : this.options.coalesceMs ?? 200)) return undefined;
    let phrase = this.pending.shift()!;
    while (this.pending.length) {
      const next = this.pending[0]!;
      // Progress narration has no source span and must retain its own ledger entry.
      if (phrase.sourceTextRange.end === 0 || next.sourceTextRange.end === 0
        || next.sourceTextRange.start < phrase.sourceTextRange.end || phrase.text.length + next.text.length + 1 > maxChars) break;
      this.pending.shift();
      phrase = { text: `${phrase.text} ${next.text}`, sourceTextRange: { start: phrase.sourceTextRange.start, end: next.sourceTextRange.end } };
    }
    if (phrase.text.length > maxChars) {
      // Only split on a weak semantic boundary, never in a number, date or token.
      const prefix = phrase.text.slice(0, maxChars);
      const boundaries = [...prefix.matchAll(/[，、,:：\s]/gu)];
      const boundary = boundaries.at(-1)?.index;
      if (boundary !== undefined && boundary > 8 && (deadline || final)) {
        this.pending.unshift({ ...phrase, text: phrase.text.slice(boundary + 1).trim() });
        phrase = { ...phrase, text: phrase.text.slice(0, boundary + 1).trim() };
      } else if (phrase.text.length > 600) {
        phrase = { ...phrase, text: '这部分内容比较长，详细结果请看屏幕。' };
      }
    }
    this.first = false;
    this.pendingAt = this.pending.length ? now : undefined;
    return phrase;
  }
  clear(): void { this.pending = []; this.pendingAt = undefined; }
  get queued(): number { return this.pending.length; }
}
