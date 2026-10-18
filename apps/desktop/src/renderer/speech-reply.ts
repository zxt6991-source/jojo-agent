import type { ReadSpeechMessageInput } from '@desktop-agent/contracts';

/** Exact committed receipts authorize either an opted-in voice-input summary or
 * the complete message explicitly requested by the user for this turn. */
export class SpeechReplyGate {
  private readonly seen = new Set<string>();
  accept(reply: { sessionId: string; messageId: string; runId: string; requestedReadAloud?: boolean | undefined; voiceInput?: boolean | undefined }, context: {
    sessionId?: string; enabled: boolean; autoReadReplies: boolean; allowPlayback: boolean; generation: number;
  }): ReadSpeechMessageInput | undefined {
    const key = JSON.stringify([reply.sessionId, reply.runId, reply.messageId]);
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value!);
    if (context.sessionId !== reply.sessionId || !context.enabled || !context.allowPlayback
      || (!reply.requestedReadAloud && !(reply.voiceInput && context.autoReadReplies))) return undefined;
    return { sessionId: reply.sessionId, messageId: reply.messageId, generation: context.generation, automatic: !reply.requestedReadAloud };
  }
}
