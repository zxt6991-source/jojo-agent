import type { ContentBlock, Message, ModelRequest } from '@desktop-agent/contracts';

import type { ChatMessage } from './types.js';

export const SYSTEM_PROMPT =
  'You are a local desktop coding assistant. Use tools when useful. Never claim a tool ran unless its result is present.';

function toolResultContent(result: Extract<ContentBlock, { type: 'tool_result' }>['result']): string | unknown[] {
  if (!result.contentBlocks?.some((block) => block.type === 'image')) return result.content;
  return [
    { type: 'text', text: result.content },
    ...result.contentBlocks.flatMap((block) => block.type === 'image' ? [{
      type: 'image_url',
      image_url: { url: `data:${block.mimeType};base64,${block.data}` }
    }] : [])
  ];
}

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
            content: toolResultContent(block.result)
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
  const instructions = request.instructions?.map((value) => value.trim()).filter(Boolean) ?? [];
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
    messages: instructions.length > 0
      ? [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\n${instructions.join('\n\n')}` },
          ...toChatMessages(request.messages).slice(1)
        ]
      : toChatMessages(request.messages),
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
