import type { Message } from '@desktop-agent/contracts';
import type { RunResult } from '@desktop-agent/contracts/runtime';

/** Result.messages includes history. Only the committed terminal entry belongs
 * to the reply receipt; empty current replies never fall back to old text. */
export function selectCommittedSpeechReply(result: RunResult, finalEntryId: string | null): Message | undefined {
  if (result.status !== 'completed' || !finalEntryId) return undefined;
  const message = result.messages.find(item => item.id === finalEntryId);
  if (!message || message.role !== 'assistant' || message.metadata?.internal ||
    message.content.some(block => block.type === 'tool_call') ||
    !message.content.some(block => block.type === 'text' && block.text.trim())) return undefined;
  return message;
}
