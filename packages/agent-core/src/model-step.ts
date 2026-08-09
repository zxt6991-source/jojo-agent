import type {
  AgentEvent,
  Message,
  ModelProvider,
  ToolCall,
  ToolDefinition
} from '@desktop-agent/contracts';
import { AgentError, throwIfAborted } from './errors.js';

type ModelStepOptions = {
  model: string;
  messages: Message[];
  toolDefinitions: ToolDefinition[];
  provider: ModelProvider;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
};

export type ModelStepResult = {
  text: string;
  calls: ToolCall[];
  stopReason: string;
};

export async function runModelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  let text = '';
  let stopReason = 'stop';
  const calls: ToolCall[] = [];
  let receivedEvent = false;

  const events = options.provider.stream({
    model: options.model,
    messages: options.messages,
    tools: options.toolDefinitions,
    signal: options.signal
  });

  for await (const event of events) {
    receivedEvent = true;
    throwIfAborted(options.signal);

    switch (event.type) {
      case 'text_delta':
        text += event.text;
        options.emit({ type: 'text.delta', text: event.text });
        break;
      case 'tool_call_completed':
        calls.push(event.call);
        break;
      case 'usage':
        options.emit({
          type: 'usage',
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {})
        });
        break;
      case 'response_completed':
        stopReason = event.stopReason;
        break;
      case 'response_failed':
        throw new AgentError(event.code, event.message);
      case 'tool_call_delta':
        break;
    }
  }

  if (!receivedEvent) throw new AgentError('empty_response', 'The provider returned no events.');
  return { text, calls, stopReason };
}
