import type { Message, ToolCall, ToolResult } from '@desktop-agent/contracts';
import type { AgentRunOptions } from './types.js';

const createId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export function createUserMessage(text: string): Message {
  return {
    id: createId(),
    role: 'user',
    createdAt: now(),
    content: [{ type: 'text', text }]
  };
}

export function createAssistantMessage(text: string, calls: ToolCall[]): Message {
  return {
    id: createId(),
    role: 'assistant',
    createdAt: now(),
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((call) => ({ type: 'tool_call' as const, call }))
    ]
  };
}

export function createToolMessage(result: ToolResult): Message {
  return {
    id: createId(),
    role: 'tool',
    createdAt: now(),
    content: [{ type: 'tool_result', result }]
  };
}

export async function appendMessage(
  options: AgentRunOptions,
  messages: Message[],
  message: Message
): Promise<void> {
  messages.push(message);
  await options.commitMessage?.(message);
}
