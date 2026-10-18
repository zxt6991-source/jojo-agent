import type { ModelProvider } from '@desktop-agent/contracts';
import type { VoiceDeliveryLedger } from './voice-delivery-ledger';

/** Project the model request without editing the durable display transcript. */
export function withHeardVoiceContext(provider: ModelProvider, ledger: VoiceDeliveryLedger): ModelProvider {
  return { ...(provider.capabilities ? { capabilities: provider.capabilities } : {}), stream(request) {
    const segments = ledger.snapshot();
    const interrupted = new Map<string, string>();
    for (const segment of segments) if (segment.messageId && ['interrupted', 'cancelled', 'failed'].includes(segment.state)) {
      interrupted.set(segment.messageId, ledger.heardPrefix(segment.runId));
    }
    return provider.stream({ ...request, messages: request.messages.map(message => {
      const heard = interrupted.get(message.id);
      if (heard === undefined || message.role !== 'assistant' || message.content.some(block => block.type === 'tool_call')) return message;
      return { ...message, content: [{ type: 'text' as const, text: `${heard}\n[assistant was interrupted here]` }] };
    }) });
  } };
}
