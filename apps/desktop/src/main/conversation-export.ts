import type { Message, SessionCompactionRecord, SessionMeta, ToolCall, ToolResult } from '@desktop-agent/contracts';

const COMPACTION_START = '[Compacted conversation context]';
const COMPACTION_END = '[End compacted context]';

type ExportRecord =
  | { kind: 'user' | 'assistant' | 'system' | 'compaction'; createdAt: string; text: string; images: ImageBlock[]; iteration?: number; finalResponseOnly?: boolean }
  | { kind: 'tool'; createdAt: string; call: ToolCall; result?: ToolResult; resultCreatedAt?: string; iteration?: number };

type ImageBlock = {
  data: string;
  mimeType: string;
  name?: string | undefined;
  altText?: string | undefined;
};

type ExportTurn = { index: number; startedAt?: string; records: ExportRecord[] };

export type ConversationTrajectoryExportInput = {
  session: SessionMeta;
  messages: Message[];
  compactions?: SessionCompactionRecord[];
  exportedAt?: string;
};

function messagesWithCompactions(messages: Message[], compactions: SessionCompactionRecord[]): Message[] {
  return [
    ...messages.map((message, order) => ({ message, order: order * 2 + 1 })),
    ...compactions.map((compaction, order) => ({
      order: order * 2,
      message: {
        id: `${compaction.id}:summary`,
        role: 'user' as const,
        createdAt: compaction.createdAt,
        metadata: { internal: true },
        content: [{
          type: 'text' as const,
          text: `${COMPACTION_START}\n[Runtime compaction: ${compaction.tokensBefore} tokens before]\n${compaction.summary}\n${COMPACTION_END}`
        }]
      }
    }))
  ].sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.order - right.order)
    .map((item) => item.message);
}

function messageText(message: Message): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function messageImages(message: Message): ImageBlock[] {
  return message.content.flatMap((block) => block.type === 'image' ? [block] : []);
}

function toolCalls(message: Message): ToolCall[] {
  return message.content.flatMap((block) => block.type === 'tool_call' ? [block.call] : []);
}

function toolResults(message: Message): ToolResult[] {
  return message.content.flatMap((block) => block.type === 'tool_result' ? [block.result] : []);
}

function compactedText(text: string): string {
  return text.replace(COMPACTION_START, '').replace(COMPACTION_END, '').trim();
}

function groupMessages(messages: Message[]): ExportTurn[] {
  const turns: ExportTurn[] = [];
  const results = new Map<string, { result: ToolResult; createdAt: string }>();
  const consumedResults = new Set<string>();
  for (const message of messages) {
    for (const result of toolResults(message)) results.set(result.callId, { result, createdAt: message.createdAt });
  }

  let current: ExportTurn | undefined;
  const ensureTurn = (): ExportTurn => {
    if (current) return current;
    current = { index: turns.length + 1, records: [] };
    turns.push(current);
    return current;
  };

  for (const message of messages) {
    if (message.role === 'user') {
      const text = messageText(message);
      if (message.metadata?.internal) {
        ensureTurn().records.push({
          kind: text.includes(COMPACTION_START) ? 'compaction' : 'system',
          createdAt: message.createdAt,
          text: text.includes(COMPACTION_START) ? compactedText(text) : text,
          images: messageImages(message)
        });
      } else {
        current = { index: turns.length + 1, startedAt: message.createdAt, records: [] };
        turns.push(current);
        current.records.push({ kind: 'user', createdAt: message.createdAt, text, images: messageImages(message) });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const turn = ensureTurn();
      const text = messageText(message);
      const images = messageImages(message);
      if (text || images.length > 0) turn.records.push({
        kind: 'assistant', createdAt: message.createdAt, text, images,
        ...(message.metadata?.iteration ? { iteration: message.metadata.iteration } : {}),
        ...(message.metadata?.finalResponseOnly ? { finalResponseOnly: true } : {})
      });
      for (const call of toolCalls(message)) {
        const matched = results.get(call.id);
        if (matched) consumedResults.add(call.id);
        turn.records.push({
          kind: 'tool',
          createdAt: message.createdAt,
          call,
          ...(message.metadata?.iteration ? { iteration: message.metadata.iteration } : {}),
          ...(matched ? { result: matched.result, resultCreatedAt: matched.createdAt } : {})
        });
      }
      continue;
    }

    for (const result of toolResults(message)) {
      if (consumedResults.has(result.callId)) continue;
      consumedResults.add(result.callId);
      ensureTurn().records.push({
        kind: 'tool',
        createdAt: message.createdAt,
        call: { id: result.callId, name: result.callId, input: {} },
        result,
        resultCreatedAt: message.createdAt
      });
    }
  }
  return turns;
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inlineCode(value: string): string {
  return `<code>${html(value)}</code>`;
}

function heading(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/([\\`*_{}[\]()#+.!|>~-])/gu, '\\$1');
}

function fence(content: string, language = ''): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length));
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}${language}\n${content}\n${marker}`;
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? 'null'; }
  catch { return String(value); }
}

function imageMarkdown(image: ImageBlock, index: number): string {
  const alt = image.altText ?? image.name ?? `图片 ${index + 1}`;
  return `<img alt="${html(alt)}" src="data:${html(image.mimeType)};base64,${image.data}" />`;
}

function appendImages(lines: string[], images: ImageBlock[]): void {
  if (images.length === 0) return;
  lines.push('', '#### 图片', '');
  images.forEach((image, index) => lines.push(imageMarkdown(image, index), ''));
}

function toolState(result: ToolResult | undefined): string {
  if (!result) return '中断（无结果）';
  if (result.ok) return '完成';
  if (result.code === 'no_progress') return '无进展';
  return '失败';
}

function toolOutput(result: ToolResult): string {
  if (result.content) return result.content;
  return result.contentBlocks?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
}

function appendRecord(lines: string[], record: ExportRecord, recordIndex: number): void {
  const labels = { user: '用户', assistant: '助手', system: '系统', compaction: '上下文压缩' } as const;
  if (record.kind !== 'tool') {
    lines.push(`### #${recordIndex} ${labels[record.kind]}`, '', `- 时间：${inlineCode(record.createdAt)}`);
    if (record.iteration) lines.push(`- Agent Loop：${record.iteration}${record.finalResponseOnly ? '（强制收尾）' : ''}`);
    lines.push('');
    if (record.kind === 'user' || record.kind === 'assistant') lines.push(record.text || '_（无文本）_');
    else lines.push(fence(record.text, 'text'));
    appendImages(lines, record.images);
    return;
  }

  lines.push(
    `### #${recordIndex} 工具 · ${heading(record.call.name)}`,
    '',
    `- 调用 ID：${inlineCode(record.call.id)}`,
    `- 开始时间：${inlineCode(record.createdAt)}`,
    `- 状态：${toolState(record.result)}`
  );
  if (record.iteration) lines.push(`- Agent Loop：${record.iteration}`);
  if (record.resultCreatedAt) lines.push(`- 结束时间：${inlineCode(record.resultCreatedAt)}`);
  if (record.result?.code) lines.push(`- 结果代码：${inlineCode(record.result.code)}`);
  lines.push('', '#### 输入', '', fence(json(record.call.input), 'json'), '', '#### 输出', '');
  if (record.result) lines.push(fence(toolOutput(record.result), 'text'));
  else lines.push('_（没有持久化的工具结果）_');
  appendImages(lines, record.result?.contentBlocks?.flatMap((block) => block.type === 'image' ? [block] : []) ?? []);
}

export function trajectoryExportFilename(title: string): string {
  const normalized = title.normalize('NFKC')
    .replace(/[\p{Cc}<>:"/\\|?*%]/gu, '-')
    .replace(/[. ]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 96) || 'conversation';
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(normalized) ? `${normalized}-session` : normalized;
  return `${safe}-trajectory.md`;
}

export function renderConversationTrajectoryMarkdown(input: ConversationTrajectoryExportInput): string {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const turns = groupMessages(messagesWithCompactions(input.messages, input.compactions ?? []));
  const lines = [
    `# ${heading(input.session.title)} · 会话轨迹`,
    '',
    `- 会话 ID：${inlineCode(input.session.id)}`,
    `- 项目：${input.session.projectBound === false ? '未选择项目' : inlineCode(input.session.workingDirectory)}`,
    `- 创建时间：${inlineCode(input.session.createdAt)}`,
    `- 最近更新：${inlineCode(input.session.updatedAt)}`,
    `- 导出时间：${inlineCode(exportedAt)}`,
    `- 原始消息数：${input.messages.length}`,
    `- 上下文压缩数：${input.compactions?.length ?? 0}`,
    '',
    '> 此文件按应用“轨迹”视图的顺序导出。工具输入和输出来自会话存储的完整原始记录，图片以内嵌 data URL 保留。'
  ];

  let recordIndex = 0;
  for (const turn of turns) {
    lines.push('', '---', '', `## 第 ${turn.index} 轮`);
    if (turn.startedAt) lines.push('', `开始时间：${inlineCode(turn.startedAt)}`);
    for (const record of turn.records) {
      lines.push('');
      appendRecord(lines, record, ++recordIndex);
    }
  }
  if (turns.length === 0) lines.push('', '---', '', '_当前会话没有可导出的轨迹记录。_');
  return `${lines.join('\n').replace(/\n{4,}/gu, '\n\n\n')}\n`;
}
