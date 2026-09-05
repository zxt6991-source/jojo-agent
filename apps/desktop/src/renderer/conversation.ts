import type { AgentEvent, ImageContentBlock, Message, SessionCompactionRecord, ToolCall, ToolResult } from '@desktop-agent/contracts';

export type ConversationViewMode = 'chat' | 'trajectory';
export type ToolRowState = 'running' | 'ok' | 'warning' | 'error' | 'stopped';

export type LiveTool = {
  id: string;
  name: string;
  input: unknown;
  progress: string;
  result?: ToolResult;
};

export type LiveStep = {
  text: string;
  tools: LiveTool[];
};

export type UserNode = { kind: 'user'; id: string; createdAt: string; text: string; images: ImageContentBlock[]; files: Extract<Message['content'][number], { type: 'text' }>[] };
export type AssistantNode = {
  kind: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
  iteration?: number;
  finalResponseOnly?: boolean;
  automation?: NonNullable<Message['metadata']>['automation'];
};
export type ToolNode = {
  kind: 'tool';
  id: string;
  callId: string;
  name: string;
  title: string;
  summary: string;
  input: unknown;
  body: string | null;
  output: string | null;
  progress: string;
  errorSummary: string | null;
  images: Extract<NonNullable<ToolResult['contentBlocks']>[number], { type: 'image' }>[];
  state: ToolRowState;
  iteration?: number;
};
export type CompactionNode = { kind: 'compaction'; id: string; summary: string; text: string };
export type SystemNode = { kind: 'system'; id: string; title: string; text: string };
export type ConversationNode = UserNode | AssistantNode | ToolNode | CompactionNode | SystemNode;

export type ConversationTurn = {
  id: string;
  index: number;
  startedAt?: string;
  nodes: ConversationNode[];
};

export type TrajectoryRecord = {
  id: string;
  index: number;
  turn: number;
  kind: ConversationNode['kind'];
  title: string;
  summary: string;
  state: ToolRowState | null;
  body: string | null;
  output: string | null;
  iteration: number | null;
  finalResponseOnly: boolean;
};

export type ConversationSnapshot = {
  turns: ConversationTurn[];
  nodes: ConversationNode[];
  records: TrajectoryRecord[];
};

export type ConversationSnapshotInput = {
  messages: Message[];
  compactions?: SessionCompactionRecord[];
  liveSteps?: LiveStep[];
  running?: boolean;
  workingDirectory?: string;
};

const DISPLAY_LIMIT = 8_000;
const COMPACTION_START = '[Compacted conversation context]';
const COMPACTION_END = '[End compacted context]';

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

const TOOL_TITLES: Record<string, string> = {
  read_file: '读取',
  list_files: '列出',
  grep: '搜索',
  glob: '匹配',
  web_search: '网页搜索',
  web_fetch: '抓取网页',
  terminal: '终端',
  write_file: '写入',
  edit_file: '编辑',
  delete_file: '删除',
  load_skill: '技能',
  install_skill: '安装',
  mcp_tool_manifest: 'MCP 清单',
  mcp_tool_describe: 'MCP 描述',
  mcp_tool_call: 'MCP 调用',
  mcp_list_resources: 'MCP 资源',
  mcp_read_resource: 'MCP 读取',
  mcp_list_prompts: 'MCP 提示词',
  mcp_get_prompt: 'MCP 提示词',
  browser_open: '打开网页',
  browser_new_page: '新建网页',
  browser_pages: '网页列表',
  browser_select_page: '切换网页',
  browser_close_page: '关闭网页',
  browser_record_start: '开始网页录制',
  browser_record_stop: '停止网页录制',
  browser_record_cancel: '取消网页录制',
  browser_recordings: '网页录制列表',
  browser_record_get: '查看网页录制',
  browser_record_delete: '删除网页录制',
  browser_replay: '回放网页流程',
  browser_read: '读取页面',
  browser_eval: '网页脚本',
  browser_wait: '等待页面',
  browser_scroll: '滚动页面',
  browser_click: '点击网页',
  browser_hover: '悬停网页',
  browser_type: '输入网页',
  browser_press: '网页按键',
  browser_select: '网页选择',
  browser_upload: '网页上传',
  browser_back: '网页后退',
  browser_reload: '刷新网页',
  browser_screenshot: '网页截图',
  browser_download: '网页下载',
  browser_downloads: '下载列表',
  browser_console: '网页控制台',
  browser_network: '网页网络',
  browser_errors: '网页错误',
  browser_cookies: '网页 Cookie'
};

export function messageText(message: Message): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

export function messageImages(message: Message): ImageContentBlock[] {
  return message.content.filter((block): block is ImageContentBlock => block.type === 'image');
}

export function quoteCommandPart(value: string): string {
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (!cwd) return text;
  const root = cwd.replace(/[/\\]+$/u, '');
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
  return text;
}

export function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

export function truncateDisplay(text: string, limit = DISPLAY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[已截断 ${text.length - limit} 个字符]`;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function pickString(input: unknown, keys: readonly string[]): string | undefined {
  const record = recordValue(input);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function firstStringValue(input: unknown): string | undefined {
  const record = recordValue(input);
  if (!record) return typeof input === 'string' && input !== '' ? input : undefined;
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

export function terminalCommandLine(input: unknown): string | undefined {
  const record = recordValue(input);
  if (!record || typeof record.command !== 'string') return undefined;
  const args = Array.isArray(record.args) ? record.args.filter((part): part is string => typeof part === 'string') : [];
  return [record.command, ...args].map(quoteCommandPart).join(' ');
}

function mcpLabel(name: string): string {
  return name.replace(/^mcp__/u, '').replaceAll('__', ' / ');
}

export function toolTitle(name: string): string {
  if (TOOL_TITLES[name]) return TOOL_TITLES[name]!;
  if (name.startsWith('mcp__')) return 'MCP';
  return '工具';
}

export function toolSummary(name: string, input: unknown, cwd?: string): string {
  if (name === 'terminal') {
    const command = terminalCommandLine(input);
    if (command) return command;
  }
  const preferred = name === 'grep' || name === 'mcp_tool_manifest' || name === 'web_search'
    ? pickString(input, ['query', 'pattern'])
    : name === 'glob'
      ? pickString(input, ['pattern', 'path'])
      : name === 'web_fetch'
        ? pickString(input, ['url'])
        : name === 'load_skill' || name === 'install_skill'
          ? pickString(input, ['name', 'id', 'skill', 'path'])
          : pickString(input, ['path', 'file_path', 'command', 'query', 'pattern', 'url']);
  const raw = preferred ?? (name.startsWith('mcp__') ? mcpLabel(name) : firstStringValue(input)) ?? name;
  return relativizeToCwd(firstLine(raw), cwd);
}

export function toolBody(name: string, input: unknown): string | null {
  if (input === undefined) return null;
  if (name === 'terminal') {
    const command = terminalCommandLine(input);
    if (command) return command;
  }
  if (typeof input === 'string') return truncateDisplay(input);
  try {
    return truncateDisplay(JSON.stringify(input, null, 2));
  } catch {
    return String(input);
  }
}

function toolState(result: ToolResult | undefined, running: boolean): ToolRowState {
  if (result) return result.ok ? 'ok' : result.code === 'no_progress' ? 'warning' : 'error';
  return running ? 'running' : 'stopped';
}

function toolOutput(result: ToolResult | undefined, progress: string): string | null {
  if (result?.content) return truncateDisplay(result.content);
  if (progress) return truncateDisplay(progress);
  return null;
}

function toolErrorSummary(result: ToolResult | undefined): string | null {
  if (!result || result.ok) return null;
  return firstLine(result.content) || result.code || '失败';
}

export function createToolNode(options: {
  id: string;
  callId: string;
  name: string;
  input: unknown;
  progress?: string;
  result?: ToolResult;
  running?: boolean;
  workingDirectory?: string;
  iteration?: number;
}): ToolNode {
  const progress = options.progress ?? '';
  const state = toolState(options.result, options.running === true);
  return {
    kind: 'tool',
    id: options.id,
    callId: options.callId,
    name: options.name,
    title: toolTitle(options.name),
    summary: state === 'error' && toolErrorSummary(options.result)
      ? toolErrorSummary(options.result)!
      : toolSummary(options.name, options.input, options.workingDirectory),
    input: options.input,
    body: toolBody(options.name, options.input),
    output: toolOutput(options.result, progress),
    progress,
    errorSummary: toolErrorSummary(options.result),
    images: options.result?.contentBlocks?.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image') ?? [],
    state,
    ...(options.iteration ? { iteration: options.iteration } : {})
  };
}

function isCompactionText(text: string): boolean {
  return text.includes(COMPACTION_START);
}

export function compactionBody(text: string): string {
  return text.replace(COMPACTION_START, '').replace(COMPACTION_END, '').trim();
}

function systemTitle(text: string): string {
  if (text.startsWith('Continue exactly where the previous response stopped')) return '续写输出';
  if (text.startsWith('The tool-capable Agent Loop reached')) return 'Agent Loop 已进入强制收尾';
  if (text.includes('Tool use is now paused')) return '停止继续调查';
  return '系统';
}

function compactionSummaryText(text: string): string {
  const body = compactionBody(text);
  const line = body.split('\n').map((item) => item.trim())
    .find((item) => Boolean(item) && !item.startsWith('[Runtime compaction:'));
  return line ? line.slice(0, 96) : '已压缩较早对话';
}

function assistantCalls(message: Message): ToolCall[] {
  return message.content.flatMap((block) => block.type === 'tool_call' ? [block.call] : []);
}

function toolResults(message: Message): ToolResult[] {
  return message.content.flatMap((block) => block.type === 'tool_result' ? [block.result] : []);
}

function foldMessages(messages: Message[], workingDirectory: string | undefined): ConversationNode[] {
  const nodes: ConversationNode[] = [];
  const consumed = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      const text = messageText(message);
      if (message.metadata?.internal) {
        if (isCompactionText(text)) {
          nodes.push({
            kind: 'compaction',
            id: message.id,
            summary: compactionSummaryText(text),
            text: compactionBody(text)
          });
        } else {
          nodes.push({ kind: 'system', id: message.id, title: systemTitle(text), text });
        }
      } else {
        nodes.push({
          kind: 'user', id: message.id, createdAt: message.createdAt,
          text: message.content.flatMap((block) => block.type === 'text' && !block.attachment ? [block.text] : []).join(''),
          images: messageImages(message),
          files: message.content.filter((block): block is Extract<typeof block, { type: 'text' }> => (
            block.type === 'text' && Boolean(block.attachment)
          ))
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const text = messageText(message);
      if (text.trim()) nodes.push({
        kind: 'assistant', id: message.id, text, streaming: false,
        ...(message.metadata?.iteration ? { iteration: message.metadata.iteration } : {}),
        ...(message.metadata?.finalResponseOnly ? { finalResponseOnly: true } : {}),
        ...(message.metadata?.source === 'scheduler' && message.metadata.automation
          ? { automation: message.metadata.automation }
          : {})
      });
      const calls = assistantCalls(message);
      if (calls.length === 0) continue;
      const results = new Map<string, ToolResult>();
      for (let next = index + 1; next < messages.length; next += 1) {
        const candidate = messages[next]!;
        if (candidate.role !== 'tool') break;
        for (const result of toolResults(candidate)) results.set(result.callId, result);
      }
      for (const call of calls) {
        consumed.add(call.id);
        const result = results.get(call.id);
        nodes.push(createToolNode({
          id: `tool:${call.id}`,
          callId: call.id,
          name: call.name,
          input: call.input,
          ...(message.metadata?.iteration ? { iteration: message.metadata.iteration } : {}),
          ...(result ? { result } : {}),
          ...(workingDirectory ? { workingDirectory } : {})
        }));
      }
      continue;
    }

    for (const result of toolResults(message)) {
      if (consumed.has(result.callId)) continue;
      consumed.add(result.callId);
      nodes.push(createToolNode({
        id: `tool:${result.callId}`,
        callId: result.callId,
        name: result.callId,
        input: {},
        result,
        ...(workingDirectory ? { workingDirectory } : {})
      }));
    }
  }

  return nodes;
}

function appendLiveSteps(
  nodes: ConversationNode[],
  liveSteps: LiveStep[],
  running: boolean,
  workingDirectory: string | undefined
): ConversationNode[] {
  const seen = new Set(nodes.flatMap((node) => node.kind === 'tool' ? [node.callId] : []));
  const next = [...nodes];
  liveSteps.forEach((step, index) => {
    if (step.text.trim()) {
      next.push({ kind: 'assistant', id: `live-assistant-${index}`, text: step.text, streaming: running });
    }
    for (const tool of step.tools) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      next.push(createToolNode({
        id: `tool:${tool.id}`,
        callId: tool.id,
        name: tool.name,
        input: tool.input,
        progress: tool.progress,
        ...(tool.result ? { result: tool.result } : {}),
        running: running && !tool.result,
        ...(workingDirectory ? { workingDirectory } : {})
      }));
    }
  });
  return next;
}

export function groupTurns(nodes: ConversationNode[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  const openTurn = (id: string, startedAt?: string): ConversationTurn => {
    const turn: ConversationTurn = {
      id,
      index: turns.length + 1,
      ...(startedAt ? { startedAt } : {}),
      nodes: []
    };
    turns.push(turn);
    return turn;
  };

  for (const node of nodes) {
    if (node.kind === 'user') {
      current = openTurn(node.id, node.createdAt);
      current.nodes.push(node);
      continue;
    }
    if (!current) current = openTurn(`turn-${turns.length + 1}`);
    current.nodes.push(node);
  }
  return turns;
}

function recordTitle(node: ConversationNode): string {
  if (node.kind === 'user') return '用户';
  if (node.kind === 'assistant') return '助手';
  if (node.kind === 'tool') return node.title;
  if (node.kind === 'compaction') return '压缩';
  return node.title;
}

function recordSummary(node: ConversationNode): string {
  if (node.kind === 'user') return firstLine(node.text) || node.files.map((file) => file.attachment?.name).filter(Boolean).join('、') || '图片';
  if (node.kind === 'assistant') return firstLine(node.text) || '…';
  if (node.kind === 'tool') return node.summary;
  if (node.kind === 'compaction') return node.summary;
  return firstLine(node.text) || node.title;
}

export function toTrajectoryRecords(turns: ConversationTurn[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const turn of turns) {
    for (const node of turn.nodes) {
      records.push({
        id: node.id,
        index: records.length + 1,
        turn: turn.index,
        kind: node.kind,
        title: recordTitle(node),
        summary: recordSummary(node),
        state: node.kind === 'tool' ? node.state : null,
        body: node.kind === 'tool' ? node.body : node.kind === 'user' || node.kind === 'assistant' || node.kind === 'system' || node.kind === 'compaction' ? node.text : null,
        output: node.kind === 'tool' ? node.output : null,
        iteration: node.kind === 'assistant' || node.kind === 'tool' ? node.iteration ?? null : null,
        finalResponseOnly: node.kind === 'assistant' && node.finalResponseOnly === true
      });
    }
  }
  return records;
}

export function buildConversationSnapshot(input: ConversationSnapshotInput): ConversationSnapshot {
  const folded = foldMessages(messagesWithCompactions(input.messages, input.compactions ?? []), input.workingDirectory);
  const nodes = appendLiveSteps(folded, input.liveSteps ?? [], input.running === true, input.workingDirectory);
  const turns = groupTurns(nodes);
  return { turns, nodes, records: toTrajectoryRecords(turns) };
}

export function emptyLiveSteps(): LiveStep[] {
  return [{ text: '', tools: [] }];
}

export function applyLiveEvent(steps: LiveStep[], event: AgentEvent): LiveStep[] {
  switch (event.type) {
    case 'turn.started':
      return emptyLiveSteps();
    case 'text.delta': {
      const next = cloneSteps(steps.length > 0 ? steps : emptyLiveSteps());
      const last = next[next.length - 1]!;
      if (last.tools.length > 0) next.push({ text: event.text, tools: [] });
      else last.text += event.text;
      return next;
    }
    case 'tool.started': {
      const next = cloneSteps(steps.length > 0 ? steps : emptyLiveSteps());
      const last = next[next.length - 1]!;
      last.tools.push({ id: event.id, name: event.name, input: event.input, progress: '' });
      return next;
    }
    case 'tool.progress':
      return cloneSteps(steps).map((step) => ({
        ...step,
        tools: step.tools.map((tool) => tool.id === event.id ? { ...tool, progress: tool.progress + event.text } : tool)
      }));
    case 'tool.finished':
      return cloneSteps(steps).map((step) => ({
        ...step,
        tools: step.tools.map((tool) => tool.id === event.id ? { ...tool, result: event.result } : tool)
      }));
    case 'turn.completed':
    case 'turn.cancelled':
    case 'turn.failed':
      return [];
    default:
      return steps;
  }
}

function cloneSteps(steps: LiveStep[]): LiveStep[] {
  return steps.map((step) => ({ text: step.text, tools: step.tools.map((tool) => ({ ...tool })) }));
}

export function hasLiveOutput(snapshot: ConversationSnapshot): boolean {
  return snapshot.nodes.some((node) => (
    (node.kind === 'assistant' && node.streaming && node.text.trim() !== '')
    || (node.kind === 'tool' && node.state === 'running')
  ));
}
