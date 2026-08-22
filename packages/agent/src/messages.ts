import type { ImageContentBlock, Message, ToolCall, ToolResult } from '@desktop-agent/contracts';
import type { AgentRunOptions } from './types.js';

const createId = (): string => crypto.randomUUID();
const now = () => new Date().toISOString();

export function createUserMessage(text: string, images: ImageContentBlock[] = []): Message {
  return {
    id: createId(),
    role: 'user',
    createdAt: now(),
    content: [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...images
    ]
  };
}

export function createAssistantMessage(
  text: string,
  calls: ToolCall[],
  id = createId(),
  metadata?: { iteration?: number; finalResponseOnly?: boolean }
): Message {
  return {
    id,
    role: 'assistant',
    createdAt: now(),
    ...(metadata ? { metadata } : {}),
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((call) => ({ type: 'tool_call' as const, call }))
    ]
  };
}

export function createToolMessage(result: ToolResult, id = createId()): Message {
  return {
    id,
    role: 'tool',
    createdAt: now(),
    content: [{ type: 'tool_result', result }]
  };
}

export function createContinuationMessage(): Message {
  return {
    id: createId(), role: 'user', createdAt: now(), metadata: { internal: true },
    content: [{ type: 'text', text: 'Continue exactly where the previous response stopped. Do not repeat completed content.' }]
  };
}

export function createNoProgressFinalMessage(): Message {
  return {
    id: createId(), role: 'user', createdAt: now(), metadata: { internal: true },
    content: [{
      type: 'text',
      text: 'Tool use is now paused because repeated investigation did not produce enough progress. Do not request more tools. Give the user the best final answer supported by the existing results, clearly stating the remaining limitation and the next concrete action.'
    }]
  };
}

export function createIterationLimitFinalMessage(maxIterations: number): Message {
  return {
    id: createId(), role: 'user', createdAt: now(), metadata: { internal: true },
    content: [{
      type: 'text',
      text: `The tool-capable Agent Loop reached its ${maxIterations}-iteration budget. Tool use is now disabled for one mandatory final response. Summarize what was completed, preserve concrete results and artifact paths, state exactly what remains unfinished, and give the next actionable step. Do not request another tool or claim unfinished work succeeded.`
    }]
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
