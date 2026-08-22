import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { ChatTranscript, TrajectoryView } from './ConversationViews';
import { buildConversationSnapshot } from './conversation';

vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: string): Message {
  return { id, role, createdAt, content: [{ type: 'text', text }] };
}

describe('ChatTranscript', () => {
  it('renders turn-owned content before the next user turn', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        message('user-1', 'user', '第一问', '2026-08-20T10:00:00.000Z'),
        message('assistant-1', 'assistant', '第一答', '2026-08-20T10:00:01.000Z'),
        message('user-2', 'user', '第二问', '2026-08-20T10:01:00.000Z'),
        message('assistant-2', 'assistant', '第二答', '2026-08-20T10:01:01.000Z')
      ]
    });
    const html = renderToStaticMarkup(React.createElement(ChatTranscript, {
      snapshot,
      running: false,
      turnStartedAt: null,
      renderAfterTurn: (turn) => React.createElement('span', null, `workflow:${turn.id}`)
    }));

    expect(html.indexOf('第一答')).toBeLessThan(html.indexOf('workflow:user-1'));
    expect(html.indexOf('workflow:user-1')).toBeLessThan(html.indexOf('第二问'));
    expect(html.indexOf('第二答')).toBeLessThan(html.indexOf('workflow:user-2'));
  });
});

describe('TrajectoryView', () => {
  it('renders a stable five-cell row whether optional Loop and state values exist or not', () => {
    const snapshot = buildConversationSnapshot({
      messages: [
        message('user-1', 'user', '执行任务', '2026-08-20T10:00:00.000Z'),
        {
          id: 'assistant-1', role: 'assistant', createdAt: '2026-08-20T10:00:01.000Z',
          metadata: { iteration: 1 },
          content: [
            { type: 'text', text: '开始读取。' },
            { type: 'tool_call', call: { id: 'call-1', name: 'read_file', input: { path: '/very/long/path/to/file.md' } } }
          ]
        },
        {
          id: 'tool-1', role: 'tool', createdAt: '2026-08-20T10:00:02.000Z',
          content: [{ type: 'tool_result', result: { callId: 'call-1', ok: true, content: 'done' } }]
        }
      ]
    });
    const html = renderToStaticMarkup(React.createElement(TrajectoryView, {
      snapshot,
      selectedId: null,
      onSelect: () => undefined
    }));
    const rows = html.match(/<button[^>]*class="trajectory-row[\s\S]*?<\/button>/gu) ?? [];

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => (row.match(/<span/gu) ?? []).length === 5)).toBe(true);
    expect(rows[0]).toContain('class="trajectory-loop " aria-hidden="true"');
    expect(rows[2]).toContain('class="trajectory-state ok"');
  });
});
