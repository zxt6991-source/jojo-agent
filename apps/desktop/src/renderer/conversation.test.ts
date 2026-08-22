import { describe, expect, it } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import {
  applyLiveEvent,
  buildConversationSnapshot,
  compactionBody,
  relativizeToCwd,
  terminalCommandLine,
  toolSummary,
  toolTitle
} from './conversation';

const at = '2026-08-15T02:00:00.000Z';

function user(id: string, text: string, internal = false): Message {
  return {
    id,
    role: 'user',
    createdAt: at,
    content: [{ type: 'text', text }],
    ...(internal ? { metadata: { internal: true } } : {})
  };
}

function assistant(id: string, text: string, calls: Array<{ id: string; name: string; input: unknown }> = []): Message {
  return {
    id,
    role: 'assistant',
    createdAt: at,
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((call) => ({ type: 'tool_call' as const, call }))
    ]
  };
}

function tool(id: string, callId: string, ok: boolean, content: string, code?: string): Message {
  return {
    id,
    role: 'tool',
    createdAt: at,
    content: [{ type: 'tool_result', result: { callId, ok, content, ...(code ? { code } : {}) } }]
  };
}

describe('conversation snapshot', () => {
  it('keeps tools in stream position after reload', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        user('u1', '列出目录'),
        assistant('a1', '先看一下结构。', [{ id: 'c1', name: 'list_files', input: { path: '.', depth: 2 } }]),
        tool('t1', 'c1', true, 'README.md\nsrc/'),
        assistant('a2', '这是一个桌面 Agent。')
      ]
    });
    expect(snapshot.nodes.map((node) => node.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(snapshot.nodes[2]).toMatchObject({
      kind: 'tool',
      title: '列出',
      summary: '.',
      state: 'ok'
    });
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.records.map((record) => record.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('renders compaction and continuation as disclosure nodes', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        user('c1', '[Compacted conversation context]\nEarlier work on auth.\n[End compacted context]', true),
        user('s1', 'Continue exactly where the previous response stopped. Do not repeat completed content.', true),
        user('u1', '继续'),
        assistant('a1', '好的')
      ]
    });
    expect(snapshot.nodes[0]).toMatchObject({ kind: 'compaction', summary: 'Earlier work on auth.' });
    expect(snapshot.nodes[1]).toMatchObject({ kind: 'system', title: '续写输出' });
    expect(compactionBody('[Compacted conversation context]\nEarlier work on auth.\n[End compacted context]')).toBe('Earlier work on auth.');
  });

  it('merges durable runtime compactions into their chronological stream position', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        { ...user('u1', '第一问'), createdAt: '2026-08-15T02:00:00.000Z' },
        { ...assistant('a1', '答一'), createdAt: '2026-08-15T02:01:00.000Z' },
        { ...user('u2', '第二问'), createdAt: '2026-08-15T02:03:00.000Z' }
      ],
      compactions: [{
        id: 'compact-1', createdAt: '2026-08-15T02:02:00.000Z',
        summary: '保留第一问的约束。', tokensBefore: 14_000
      }]
    });

    expect(snapshot.nodes.map((node) => node.kind)).toEqual(['user', 'assistant', 'compaction', 'user']);
    expect(snapshot.nodes[2]).toMatchObject({ kind: 'compaction', summary: '保留第一问的约束。' });
  });

  it('appends live steps without duplicating persisted tools', () => {
    const snapshot = buildConversationSnapshot({
      running: true,
      messages: [
        user('u1', '搜索'),
        assistant('a1', '', [{ id: 'c1', name: 'grep', input: { query: 'AgentEvent' } }]),
        tool('t1', 'c1', true, 'src/agent.ts:1:export type AgentEvent')
      ],
      liveSteps: [
        { text: '', tools: [{ id: 'c1', name: 'grep', input: { query: 'AgentEvent' }, progress: '' }] },
        { text: '找到定义了。', tools: [{ id: 'c2', name: 'read_file', input: { path: '/repo/src/agent.ts' }, progress: 'loading' }] }
      ],
      workingDirectory: '/repo'
    });
    const tools = snapshot.nodes.filter((node) => node.kind === 'tool');
    expect(tools.map((node) => node.callId)).toEqual(['c1', 'c2']);
    expect(tools[1]).toMatchObject({ summary: 'src/agent.ts', state: 'running' });
    expect(snapshot.nodes.at(-2)).toMatchObject({ kind: 'assistant', text: '找到定义了。', streaming: true });
  });

  it('groups each user message into a new turn', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        user('u1', '第一问'),
        assistant('a1', '答一'),
        user('u2', '第二问'),
        assistant('a2', '答二')
      ]
    });
    expect(snapshot.turns.map((turn) => turn.nodes[0])).toMatchObject([
      { kind: 'user', text: '第一问' },
      { kind: 'user', text: '第二问' }
    ]);
    expect(snapshot.turns.map((turn) => turn.startedAt)).toEqual([at, at]);
    expect(snapshot.records.filter((record) => record.turn === 2).map((record) => record.kind)).toEqual(['user', 'assistant']);
  });

  it('marks unfinished persisted tools as stopped after the turn ends', () => {
    const snapshot = buildConversationSnapshot({
      running: false,
      messages: [
        user('u1', '运行测试'),
        assistant('a1', '', [{ id: 'c1', name: 'terminal', input: { command: 'pnpm', args: ['test'] } }])
      ]
    });
    expect(snapshot.nodes[1]).toMatchObject({ kind: 'tool', state: 'stopped', summary: 'pnpm test' });
  });

  it('renders no-progress control results as warnings instead of tool failures', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        user('u1', '搜索定义'),
        assistant('a1', '', [{ id: 'c1', name: 'grep', input: { query: 'Entry', path: 'src' } }]),
        tool('t1', 'c1', false, '[No progress: duplicate observation.]', 'no_progress')
      ]
    });

    expect(snapshot.nodes[1]).toMatchObject({
      kind: 'tool', state: 'warning', summary: 'Entry', errorSummary: '[No progress: duplicate observation.]'
    });
    expect(snapshot.records[1]).toMatchObject({ state: 'warning', summary: 'Entry' });
  });
});

describe('live events', () => {
  it('starts a new step after tools when more text arrives', () => {
    let steps = applyLiveEvent([], { type: 'turn.started', sessionId: 's', turnId: 't' });
    steps = applyLiveEvent(steps, { type: 'text.delta', text: '先读文件。' });
    steps = applyLiveEvent(steps, { type: 'tool.started', id: 'c1', name: 'read_file', input: { path: 'README.md' } });
    steps = applyLiveEvent(steps, { type: 'tool.finished', id: 'c1', result: { callId: 'c1', ok: true, content: '# Agent' } });
    steps = applyLiveEvent(steps, { type: 'text.delta', text: '这是说明。' });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.text).toBe('先读文件。');
    expect(steps[0]?.tools[0]?.result?.content).toBe('# Agent');
    expect(steps[1]?.text).toBe('这是说明。');
  });

  it('clears live steps when the turn settles', () => {
    const running = applyLiveEvent([], { type: 'text.delta', text: '…' });
    expect(applyLiveEvent(running, { type: 'turn.completed', stopReason: 'stop' })).toEqual([]);
  });
});

describe('tool presentation', () => {
  it('uses Chinese titles and argument summaries', () => {
    expect(toolTitle('read_file')).toBe('读取');
    expect(toolTitle('mcp__github__create_issue')).toBe('MCP');
    expect(toolSummary('grep', { query: 'AgentEvent', path: 'src' })).toBe('AgentEvent');
    expect(toolSummary('web_search', { query: 'zod schema', maxResults: 5 })).toBe('zod schema');
    expect(toolSummary('web_fetch', { url: 'https://example.com/docs', clean: true })).toBe('https://example.com/docs');
    expect(toolTitle('web_search')).toBe('网页搜索');
    expect(toolTitle('web_fetch')).toBe('抓取网页');
    expect(toolTitle('browser_eval')).toBe('网页脚本');
    expect(toolTitle('browser_hover')).toBe('悬停网页');
    expect(toolTitle('browser_cookies')).toBe('网页 Cookie');
    expect(toolTitle('browser_record_cancel')).toBe('取消网页录制');
    expect(toolTitle('browser_record_get')).toBe('查看网页录制');
    expect(toolTitle('browser_record_delete')).toBe('删除网页录制');
    expect(toolSummary('read_file', { path: '/repo/apps/desktop/src/renderer/main.tsx' }, '/repo')).toBe('apps/desktop/src/renderer/main.tsx');
    expect(terminalCommandLine({ command: 'pnpm', args: ['test', '--', 'agent'] })).toBe('pnpm test -- agent');
    expect(relativizeToCwd('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('surfaces the first error line as the collapsed summary', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        user('u1', '删除'),
        assistant('a1', '', [{ id: 'c1', name: 'delete_file', input: { path: 'secret.env' } }]),
        tool('t1', 'c1', false, 'File changes require approval.\nDenied')
      ]
    });
    expect(snapshot.nodes[1]).toMatchObject({
      kind: 'tool',
      state: 'error',
      summary: 'File changes require approval.',
      errorSummary: 'File changes require approval.'
    });
  });
});
