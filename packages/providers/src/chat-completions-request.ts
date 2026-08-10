import type { ContentBlock, Message, ModelRequest } from '@desktop-agent/contracts';

import type { ChatMessage } from './types.js';

export const SYSTEM_PROMPT =
  'You are a local desktop coding assistant. Use tools when useful. Never claim a tool ran unless its result is present.';

function textContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function toChatMessages(messages: Message[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          chatMessages.push({
            role: 'tool',
            tool_call_id: block.result.callId,
            content: block.result.content
          });
        }
      }
      continue;
    }

    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_call' }> => block.type === 'tool_call')
      .map((block) => ({
        id: block.call.id,
        type: 'function',
        function: {
          name: block.call.name,
          arguments: JSON.stringify(block.call.input)
        }
      }));

    chatMessages.push({
      role: message.role,
      content: textContent(message.content) || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });
  }

  return chatMessages;
}

export function createChatCompletionBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
    messages: toChatMessages(request.messages),
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))
  };
}
