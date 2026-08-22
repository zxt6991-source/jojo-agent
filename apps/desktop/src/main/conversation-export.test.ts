import { describe, expect, it } from 'vitest';
import type { Message, SessionMeta } from '@desktop-agent/contracts';
import { renderConversationTrajectoryMarkdown, trajectoryExportFilename } from './conversation-export';

const session: SessionMeta = {
  id: 'session-1',
  title: '检查 API / 工具',
  workingDirectory: '/repo',
  createdAt: '2026-08-22T01:00:00.000Z',
  updatedAt: '2026-08-22T02:00:00.000Z'
};

describe('conversation trajectory export', () => {
  it('exports turns, internal records, complete tool IO, status, and embedded images', () => {
    const longOutput = 'x'.repeat(8_500);
    const messages: Message[] = [
      { id: 'compact', role: 'user', createdAt: '2026-08-22T01:00:00.000Z', metadata: { internal: true }, content: [{ type: 'text', text: '[Compacted conversation context]\nEarlier context\n[End compacted context]' }] },
      { id: 'u1', role: 'user', createdAt: '2026-08-22T01:01:00.000Z', content: [{ type: 'text', text: '运行检查' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', name: 'sample.png' }] },
      { id: 'a1', role: 'assistant', createdAt: '2026-08-22T01:01:01.000Z', metadata: { iteration: 12, finalResponseOnly: true }, content: [{ type: 'text', text: '开始。' }, { type: 'tool_call', call: { id: 'call-1', name: 'terminal', input: { command: 'pnpm', args: ['test'] } } }] },
      { id: 't1', role: 'tool', createdAt: '2026-08-22T01:01:02.000Z', content: [{ type: 'tool_result', result: { callId: 'call-1', ok: false, code: 'no_progress', content: longOutput } }] }
    ];

    const markdown = renderConversationTrajectoryMarkdown({
      session,
      messages,
      compactions: [{
        id: 'runtime-compact', createdAt: '2026-08-22T01:00:30.000Z',
        summary: 'Runtime durable context', tokensBefore: 16_205
      }],
      exportedAt: '2026-08-22T03:00:00.000Z'
    });

    expect(markdown).toContain('# 检查 API / 工具 · 会话轨迹');
    expect(markdown).toContain('## 第 1 轮');
    expect(markdown).toContain('### #1 上下文压缩');
    expect(markdown).toContain('- 上下文压缩数：1');
    expect(markdown).toContain('Runtime durable context');
    expect(markdown).toContain('[Runtime compaction: 16205 tokens before]');
    expect(markdown).toContain('## 第 2 轮');
    expect(markdown).toContain('### #5 工具 · terminal');
    expect(markdown).toContain('- 状态：无进展');
    expect(markdown).toContain('- Agent Loop：12（强制收尾）');
    expect(markdown).toContain('"command": "pnpm"');
    expect(markdown).toContain(longOutput);
    expect(markdown).not.toContain('[已截断');
    expect(markdown).toContain('src="data:image/png;base64,aGVsbG8="');
  });

  it('creates a portable filename', () => {
    expect(trajectoryExportFilename('  API: 调试 / 第一轮.  ')).toBe('API- 调试 - 第一轮-trajectory.md');
    expect(trajectoryExportFilename('CON')).toBe('CON-session-trajectory.md');
    expect(trajectoryExportFilename('///')).toBe('----trajectory.md');
  });
});
