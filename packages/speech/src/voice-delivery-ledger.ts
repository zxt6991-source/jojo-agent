export type VoiceDeliveryState = 'queued' | 'synthesizing' | 'ready' | 'playing' | 'partially_played' | 'played' | 'interrupted' | 'cancelled' | 'failed';
export interface VoiceDeliverySegment {
  id: string; voiceSessionId: string; turnId: string; runId: string; messageId?: string; generation: number;
  sourceTextRange?: { start: number; end: number }; spokenText: string; state: VoiceDeliveryState; playedMs: number;
}
export interface VoiceDeliveryStore { load(): VoiceDeliverySegment[]; save(segment: VoiceDeliverySegment): void }
const terminal = new Set<VoiceDeliveryState>(['played', 'interrupted', 'cancelled', 'failed']);
const transitions: Record<VoiceDeliveryState, VoiceDeliveryState[]> = {
  queued: ['synthesizing', 'cancelled', 'failed'], synthesizing: ['ready', 'cancelled', 'failed'],
  ready: ['playing', 'cancelled', 'failed'], playing: ['partially_played', 'played', 'interrupted', 'failed'],
  partially_played: ['playing', 'played', 'interrupted', 'failed'], played: [], interrupted: [], cancelled: [], failed: []
};

/** Playback ACKs, never synthesis completion, establish what was heard. */
export class VoiceDeliveryLedger {
  private readonly segments = new Map<string, VoiceDeliverySegment>();
  constructor(private readonly store?: VoiceDeliveryStore, private readonly maxSegments = 1000) {
    for (const segment of store?.load() ?? []) {
      // After a crash audio may have played, but no unacknowledged segment can
      // be claimed as heard or automatically replayed.
      this.segments.set(segment.id, { ...segment });
      if (!terminal.has(segment.state)) this.transition(segment.id, segment.generation, segment.state === 'playing' || segment.state === 'partially_played' ? 'interrupted' : 'cancelled');
    }
  }
  queue(input: Omit<VoiceDeliverySegment, 'state' | 'playedMs'>): VoiceDeliverySegment {
    const old = this.segments.get(input.id);
    if (old) {
      if (old.runId !== input.runId || old.generation !== input.generation || old.spokenText !== input.spokenText) throw new Error('voice_delivery_conflict');
      return { ...old };
    }
    if (this.segments.size >= this.maxSegments) {
      const oldest = [...this.segments.values()].find(segment => terminal.has(segment.state));
      if (!oldest) throw new Error('voice_delivery_limit');
      this.segments.delete(oldest.id);
    }
    if (!input.id || !input.runId || !input.spokenText.trim() || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('invalid_voice_delivery');
    const segment: VoiceDeliverySegment = { ...input, state: 'queued', playedMs: 0 };
    this.store?.save(segment); this.segments.set(input.id, segment);
    return { ...segment };
  }
  transition(id: string, generation: number, state: VoiceDeliveryState, playedMs?: number): boolean {
    const segment = this.segments.get(id);
    if (!segment || segment.generation !== generation) return false;
    if (state === segment.state && (playedMs === undefined || playedMs === segment.playedMs)) return true;
    if (state !== segment.state && !transitions[segment.state].includes(state)) return false;
    if (playedMs !== undefined && (!Number.isFinite(playedMs) || playedMs < segment.playedMs)) return false;
    const next = { ...segment, state, playedMs: playedMs ?? segment.playedMs };
    this.store?.save(next); this.segments.set(id, next); return true;
  }
  interrupt(runId: string, generation: number): void {
    for (const segment of this.segments.values()) if (segment.runId === runId && segment.generation === generation && !terminal.has(segment.state)) {
      this.transition(segment.id, generation, segment.state === 'playing' || segment.state === 'partially_played' ? 'interrupted' : 'cancelled');
    }
  }
  /** A stop can arrive between two phrases, or before the first phrase. The
   * empty cancelled boundary records that future display text was never heard. */
  recordUnheardBoundary(input: { runId: string; generation: number; voiceSessionId: string; turnId: string }): void {
    if ([...this.segments.values()].some(segment => segment.runId === input.runId && segment.generation === input.generation && segment.spokenText === '')) return;
    const id = crypto.randomUUID();
    if (this.segments.size >= this.maxSegments) {
      const oldest = [...this.segments.values()].find(segment => terminal.has(segment.state));
      if (!oldest) throw new Error('voice_delivery_limit');
      this.segments.delete(oldest.id);
    }
    const segment: VoiceDeliverySegment = { ...input, id, state: 'cancelled', spokenText: '', playedMs: 0 };
    this.store?.save(segment); this.segments.set(id, segment);
  }
  reconcile(runId: string, messageId: string | undefined, success: boolean): void {
    for (const segment of this.segments.values()) if (segment.runId === runId) {
      const next = { ...segment, ...(messageId ? { messageId } : {}) };
      this.store?.save(next); this.segments.set(segment.id, next);
      if (!success && !terminal.has(next.state)) this.transition(next.id, next.generation, 'failed');
    }
  }
  heardPrefix(runId: string): string {
    const heard: string[] = [];
    for (const segment of this.segments.values()) if (segment.runId === runId) {
      if (segment.state !== 'played') break;
      heard.push(segment.spokenText);
    }
    return heard.join(' ');
  }
  snapshot(): VoiceDeliverySegment[] { return [...this.segments.values()].map(segment => ({ ...segment })); }
}

/** Use as an instruction contribution on the next voice run; display history
 * remains intact. No text from an unfinished segment is assumed heard. */
export function interruptedVoiceContext(ledger: VoiceDeliveryLedger, runId: string): string | undefined {
  if (!ledger.snapshot().some(segment => segment.runId === runId && ['interrupted', 'cancelled', 'failed'].includes(segment.state))) return undefined;
  return `上一轮语音只确认用户听到了：${ledger.heardPrefix(runId) || '（没有完整播放的片段）'}\n[assistant was interrupted here]\n屏幕上的其余内容未确认听到，请不要假定用户已知。`;
}
