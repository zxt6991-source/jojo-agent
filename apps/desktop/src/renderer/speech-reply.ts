import type { ReadSpeechMessageInput } from '@desktop-agent/contracts';

/** Only an exact committed reply receipt can opt into automatic playback. */
export class SpeechReplyGate {
  private readonly seen = new Set<string>();
  accept(reply: { sessionId: string; messageId: string; runId: string }, context: {
    sessionId?: string; enabled: boolean; autoReadReplies: boolean; allowPlayback: boolean; generation: number;
  }): ReadSpeechMessageInput | undefined {
    const key = JSON.stringify([reply.sessionId, reply.runId, reply.messageId]);
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value!);
    if (context.sessionId !== reply.sessionId || !context.enabled || !context.autoReadReplies || !context.allowPlayback) return undefined;
    return { sessionId: reply.sessionId, messageId: reply.messageId, generation: context.generation, automatic: true };
  }
}
