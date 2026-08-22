import type { ContentBlock, Message, ToolDefinition } from '@desktop-agent/contracts';
import { AgentError } from './errors.js';

const TOOL_RESULT_CHARACTER_LIMIT = 12_000;
const TOOL_RESULT_EDGE_CHARACTERS = 4_000;
const SUMMARY_SOURCE_CHARACTER_LIMIT = 48_000;
const DEFAULT_TARGET_RATIO = 0.82;
const MINIMUM_MESSAGE_BUDGET_TOKENS = 1_024;
const PINNED_REQUIREMENTS_START = '[Pinned user requirements; preserve verbatim]';
const PINNED_REQUIREMENTS_END = '[End pinned user requirements]';

export type ContextPreparationOptions = {
  messages: Message[];
  tools: ToolDefinition[];
  instructions?: string[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  summarize?: (source: string, signal: AbortSignal) => Promise<string>;
  beforeCompact?: (info: { estimatedTokens: number; messageCount: number }) => Promise<void>;
  signal: AbortSignal;
};

export type ContextPreparationResult = {
  messages: Message[];
  estimatedTokens: number;
  compactedMessages: number;
  reclaimedToolCharacters: number;
  budget: ContextBudget;
  compaction?: {
    summary: string;
    retainedTail: Message[];
    tokensBefore: number;
  };
};

export type ContextBudget = {
  targetTokens: number;
  fixedTokens: number;
  messageBudgetTokens: number;
  overCapacity: boolean;
  minimumContextWindowTokens: number;
};

function textTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (const character of text) if (character.charCodeAt(0) <= 0x7f) ascii += 1;
  return Math.ceil(ascii / 4 + (text.length - ascii) * 1.25);
}

function blockTokens(block: ContentBlock): number {
  if (block.type === 'text') return textTokens(block.text) + 3;
  if (block.type === 'image') return 1_024;
  if (block.type === 'tool_call') return textTokens(block.call.name) + textTokens(JSON.stringify(block.call.input)) + 12;
  const imageTokens = block.result.contentBlocks?.reduce(
    (sum, item) => sum + (item.type === 'image' ? 1_024 : textTokens(item.text)), 0
  ) ?? 0;
  return Math.max(textTokens(block.result.content), imageTokens) + 12;
}

function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((sum, message) =>
    sum + 6 + message.content.reduce((blockSum, block) => blockSum + blockTokens(block), 0), 0);
}

function estimateInstructionTokens(instructions: string[]): number {
  return instructions.reduce((sum, instruction) => sum + textTokens(instruction) + 8, 0);
}

export function estimateContextTokens(
  messages: Message[],
  tools: ToolDefinition[] = [],
  instructions: string[] = []
): number {
  const messageTokens = estimateMessageTokens(messages);
  const toolTokens = tools.reduce((sum, tool) =>
    sum + textTokens(tool.name) + textTokens(tool.description) + textTokens(JSON.stringify(tool.inputSchema)) + 16, 0);
  return messageTokens + toolTokens + estimateInstructionTokens(instructions) + 32;
}

export function calculateContextBudget(options: Pick<
  ContextPreparationOptions,
  'tools' | 'instructions' | 'contextWindowTokens' | 'maxOutputTokens'
>): ContextBudget {
  const targetTokens = Math.max(
    1_024,
    Math.floor(options.contextWindowTokens * DEFAULT_TARGET_RATIO) - options.maxOutputTokens
  );
  const fixedTokens = estimateContextTokens([], options.tools, options.instructions ?? []);
  const messageBudgetTokens = Math.max(0, targetTokens - fixedTokens);
  return {
    targetTokens,
    fixedTokens,
    messageBudgetTokens,
    overCapacity: messageBudgetTokens < MINIMUM_MESSAGE_BUDGET_TOKENS,
    minimumContextWindowTokens: Math.ceil(
      (fixedTokens + options.maxOutputTokens + MINIMUM_MESSAGE_BUDGET_TOKENS) / DEFAULT_TARGET_RATIO
    )
  };
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
      if (block.type === 'image') return `[image ${block.name ?? block.mimeType}]`;
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

function textContent(message: Message): string {
  return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('').trim();
}

function pinnedFromCompaction(text: string): string[] {
  const start = text.indexOf(PINNED_REQUIREMENTS_START);
  const end = text.indexOf(PINNED_REQUIREMENTS_END);
  if (start < 0 || end <= start) return [];
  return text.slice(start + PINNED_REQUIREMENTS_START.length, end).split('\n').flatMap((line) => {
    const encoded = line.startsWith('- ') ? line.slice(2) : '';
    if (!encoded) return [];
    try {
      const parsed: unknown = JSON.parse(encoded);
      return typeof parsed === 'string' && parsed.trim() ? [parsed.trim()] : [];
    } catch { return []; }
  });
}

function boundedRequirement(value: string, maxTokens: number): string {
  if (textTokens(JSON.stringify(value)) <= maxTokens) return value;
  const marker = '\n[…user requirement clipped for context capacity…]\n';
  let low = 0;
  let high = Math.floor(value.length / 2);
  let best = textTokens(JSON.stringify(marker)) <= maxTokens ? marker : '';
  while (low <= high) {
    const edge = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, edge)}${marker}${value.slice(-edge)}`;
    if (textTokens(JSON.stringify(candidate)) <= maxTokens) {
      best = candidate;
      low = edge + 1;
    } else high = edge - 1;
  }
  return best;
}

function boundedSummaryText(value: string, maxTokens: number): string {
  if (textTokens(value) <= maxTokens) return value;
  const marker = '\n\n[…summary clipped…]\n\n';
  let low = 0;
  let high = Math.floor(value.length / 2);
  let best = '';
  while (low <= high) {
    const edge = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, edge)}${marker}${value.slice(-edge)}`;
    if (textTokens(candidate) <= maxTokens) {
      best = candidate;
      low = edge + 1;
    } else high = edge - 1;
  }
  return best;
}

function pinnedUserRequirements(messages: Message[], maxTokens: number): string[] {
  const values: string[] = [];
  for (const message of messages) {
    const text = textContent(message);
    if (!text || message.role !== 'user') continue;
    if (message.metadata?.internal) values.push(...pinnedFromCompaction(text));
    else values.push(text);
  }
  const unique = [...new Set(values)];
  if (unique.length === 0) return [];
  const selected: string[] = [];
  let tokens = 0;
  const candidates = (unique.length === 1 ? unique : [unique[0]!, ...unique.slice(1).reverse()]).slice(0, 8);
  for (const [index, value] of candidates.entries()) {
    const remaining = maxTokens - tokens;
    if (remaining <= 0) break;
    const remainingCandidates = candidates.length - index;
    const bounded = boundedRequirement(value, Math.floor(remaining / remainingCandidates));
    if (!bounded) continue;
    const encoded = JSON.stringify(bounded);
    const encodedTokens = textTokens(encoded);
    if (selected.length > 0 && tokens + encodedTokens > maxTokens) continue;
    selected.push(bounded);
    tokens += encodedTokens;
  }
  return selected;
}

function stableCompactionSummary(generated: string, messages: Message[], messageBudgetTokens: number): string {
  const summaryTokenBudget = Math.max(256, Math.min(3_200, Math.floor(messageBudgetTokens * 0.34)));
  const pinned = pinnedUserRequirements(messages, Math.floor(summaryTokenBudget * 0.68));
  const header = pinned.length > 0
    ? `${PINNED_REQUIREMENTS_START}\n${pinned.map((value) => `- ${JSON.stringify(value)}`).join('\n')}\n${PINNED_REQUIREMENTS_END}\n\n`
    : '';
  const summaryPrefix = '[Conversation summary; subordinate to pinned requirements]\n';
  const availableTokens = Math.max(0, summaryTokenBudget - textTokens(header) - textTokens(summaryPrefix));
  const body = boundedSummaryText(generated, availableTokens);
  return `${header}${summaryPrefix}${body}`.trim();
}

function summaryMessage(summary: string): Message {
  return {
    id: crypto.randomUUID(), role: 'user', createdAt: new Date().toISOString(), metadata: { internal: true },
    content: [{ type: 'text', text: `[Compacted conversation context]\n${summary}\n[End compacted context]` }]
  };
}

export async function prepareModelContext(options: ContextPreparationOptions): Promise<ContextPreparationResult> {
  const reclaimed = reclaimToolResults(options.messages);
  const budget = calculateContextBudget(options);
  let estimatedTokens = estimateContextTokens(reclaimed.messages, options.tools, options.instructions ?? []);
  const tokensBefore = estimatedTokens;
  if (budget.overCapacity) {
    throw new AgentError(
      'context_overflow',
      `固定指令与工具定义约需 ${budget.fixedTokens} tokens，当前目标仅 ${budget.targetTokens} tokens，无法保留最小消息预算。请将上下文窗口提高到至少 ${budget.minimumContextWindowTokens} tokens，或减少启用的工具、MCP 与 Skill。`
    );
  }
  if (estimatedTokens <= budget.targetTokens) {
    return {
      messages: reclaimed.messages,
      estimatedTokens,
      compactedMessages: 0,
      reclaimedToolCharacters: reclaimed.reclaimed,
      budget
    };
  }

  const groups = groupContextMessages(reclaimed.messages);
  const kept: Message[][] = [];
  let keptTokens = 0;
  const keepBudget = Math.max(1_024, Math.floor(budget.messageBudgetTokens * 0.62));
  while (groups.length > 1) {
    const candidate = groups.at(-1)!;
    const candidateTokens = estimateMessageTokens(candidate);
    if (kept.length > 0 && keptTokens + candidateTokens > keepBudget) break;
    kept.unshift(candidate);
    keptTokens += candidateTokens;
    groups.pop();
  }

  const compacted = groups.flat();
  if (compacted.length === 0) {
    return {
      messages: reclaimed.messages,
      estimatedTokens,
      compactedMessages: 0,
      reclaimedToolCharacters: reclaimed.reclaimed,
      budget
    };
  }

  await options.beforeCompact?.({ estimatedTokens: tokensBefore, messageCount: compacted.length });

  const source = sourceForSummary(compacted);
  let summary: string;
  try {
    summary = options.summarize ? await options.summarize(source, options.signal) : fallbackSummary(compacted);
  } catch {
    summary = fallbackSummary(compacted);
  }
  summary = stableCompactionSummary(summary, compacted, budget.messageBudgetTokens);
  const messages = [summaryMessage(summary), ...kept.flat()];
  estimatedTokens = estimateContextTokens(messages, options.tools, options.instructions ?? []);
  if (estimatedTokens > budget.targetTokens) {
    throw new AgentError(
      'context_overflow',
      `最近一组消息在压缩旧历史后仍约需 ${estimatedTokens} tokens，超过当前上下文目标 ${budget.targetTokens} tokens。请提高上下文窗口、缩短本次输入或减少启用的工具。`
    );
  }
  return {
    messages, estimatedTokens, compactedMessages: compacted.length,
    reclaimedToolCharacters: reclaimed.reclaimed,
    budget,
    compaction: { summary, retainedTail: kept.flat(), tokensBefore }
  };
}
