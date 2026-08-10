import type { ContentBlock, Message, ToolDefinition } from '@desktop-agent/contracts';

const TOOL_RESULT_CHARACTER_LIMIT = 12_000;
const TOOL_RESULT_EDGE_CHARACTERS = 4_000;
const SUMMARY_SOURCE_CHARACTER_LIMIT = 48_000;
const DEFAULT_TARGET_RATIO = 0.82;

export type ContextPreparationOptions = {
  messages: Message[];
  tools: ToolDefinition[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  summarize?: (source: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
};

export type ContextPreparationResult = {
  messages: Message[];
  estimatedTokens: number;
  compactedMessages: number;
  reclaimedToolCharacters: number;
};

function textTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (const character of text) if (character.charCodeAt(0) <= 0x7f) ascii += 1;
  return Math.ceil(ascii / 4 + (text.length - ascii) * 1.25);
}

function blockTokens(block: ContentBlock): number {
  if (block.type === 'text') return textTokens(block.text) + 3;
  if (block.type === 'tool_call') return textTokens(block.call.name) + textTokens(JSON.stringify(block.call.input)) + 12;
  return textTokens(block.result.content) + 12;
}

export function estimateContextTokens(messages: Message[], tools: ToolDefinition[] = []): number {
  const messageTokens = messages.reduce((sum, message) =>
    sum + 6 + message.content.reduce((blockSum, block) => blockSum + blockTokens(block), 0), 0);
  const toolTokens = tools.reduce((sum, tool) =>
    sum + textTokens(tool.name) + textTokens(tool.description) + textTokens(JSON.stringify(tool.inputSchema)) + 16, 0);
  return messageTokens + toolTokens + 32;
}

function reclaimToolResults(messages: Message[]): { messages: Message[]; reclaimed: number } {
  let reclaimed = 0;
  const mapped = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || block.result.content.length <= TOOL_RESULT_CHARACTER_LIMIT) return block;
      const omitted = block.result.content.length - TOOL_RESULT_EDGE_CHARACTERS * 2;
      const content = `${block.result.content.slice(0, TOOL_RESULT_EDGE_CHARACTERS)}\n\n[${omitted} characters reclaimed from older tool output]\n\n${block.result.content.slice(-TOOL_RESULT_EDGE_CHARACTERS)}`;
      reclaimed += block.result.content.length - content.length;
      return { ...block, result: { ...block.result, content, truncated: true } };
    })
  }));
  return { messages: mapped, reclaimed };
}

function messageToolCallIds(message: Message): Set<string> {
  return new Set(message.content.flatMap((block) => block.type === 'tool_call' ? [block.call.id] : []));
}

function toolResultIds(message: Message): string[] {
  return message.content.flatMap((block) => block.type === 'tool_result' ? [block.result.callId] : []);
}

/** Groups an assistant tool call and all immediately following matching results atomically. */
export function groupContextMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const group = [message];
    const callIds = messageToolCallIds(message);
    if (callIds.size > 0) {
      while (index + 1 < messages.length) {
        const next = messages[index + 1]!;
        const resultIds = toolResultIds(next);
        if (next.role !== 'tool' || resultIds.length === 0 || !resultIds.every((id) => callIds.has(id))) break;
        group.push(next);
        index += 1;
      }
    }
    groups.push(group);
  }
  return groups;
}

function sourceForSummary(messages: Message[]): string {
  const parts = messages.map((message) => {
    const content = message.content.map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_call') return `[tool call ${block.call.name} ${JSON.stringify(block.call.input)}]`;
      return `[tool result ${block.result.callId} ${block.result.ok ? 'ok' : 'failed'}: ${block.result.content}]`;
    }).join('\n');
    return `${message.role.toUpperCase()}: ${content}`;
  }).join('\n\n');
  if (parts.length <= SUMMARY_SOURCE_CHARACTER_LIMIT) return parts;
  return `${parts.slice(0, SUMMARY_SOURCE_CHARACTER_LIMIT / 2)}\n\n[summary source clipped]\n\n${parts.slice(-SUMMARY_SOURCE_CHARACTER_LIMIT / 2)}`;
}

function fallbackSummary(messages: Message[]): string {
  const source = sourceForSummary(messages);
  return source.length <= 8_000 ? source : `${source.slice(0, 4_000)}\n\n[…older details omitted…]\n\n${source.slice(-4_000)}`;
}

function summaryMessage(summary: string): Message {
  return {
    id: crypto.randomUUID(), role: 'user', createdAt: new Date().toISOString(), metadata: { internal: true },
    content: [{ type: 'text', text: `[Compacted conversation context]\n${summary}\n[End compacted context]` }]
  };
}

export async function prepareModelContext(options: ContextPreparationOptions): Promise<ContextPreparationResult> {
  const reclaimed = reclaimToolResults(options.messages);
  const target = Math.max(1_024, Math.floor(options.contextWindowTokens * DEFAULT_TARGET_RATIO) - options.maxOutputTokens);
  let estimatedTokens = estimateContextTokens(reclaimed.messages, options.tools);
  if (estimatedTokens <= target) {
    return { messages: reclaimed.messages, estimatedTokens, compactedMessages: 0, reclaimedToolCharacters: reclaimed.reclaimed };
  }

  const groups = groupContextMessages(reclaimed.messages);
  const kept: Message[][] = [];
  let keptTokens = estimateContextTokens([], options.tools);
  const keepBudget = Math.max(1_024, Math.floor(target * 0.62));
  while (groups.length > 1) {
    const candidate = groups.at(-1)!;
    const candidateTokens = estimateContextTokens(candidate);
    if (kept.length > 0 && keptTokens + candidateTokens > keepBudget) break;
    kept.unshift(candidate);
    keptTokens += candidateTokens;
    groups.pop();
  }

  const compacted = groups.flat();
  if (compacted.length === 0) {
    return { messages: reclaimed.messages, estimatedTokens, compactedMessages: 0, reclaimedToolCharacters: reclaimed.reclaimed };
  }

  const source = sourceForSummary(compacted);
  let summary: string;
  try {
    summary = options.summarize ? await options.summarize(source, options.signal) : fallbackSummary(compacted);
  } catch {
    summary = fallbackSummary(compacted);
  }
  if (summary.length > 12_000) summary = `${summary.slice(0, 6_000)}\n\n[…summary clipped…]\n\n${summary.slice(-6_000)}`;
  const messages = [summaryMessage(summary), ...kept.flat()];
  estimatedTokens = estimateContextTokens(messages, options.tools);
  return {
    messages, estimatedTokens, compactedMessages: compacted.length,
    reclaimedToolCharacters: reclaimed.reclaimed
  };
}
