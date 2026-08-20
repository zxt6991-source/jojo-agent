import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { ChatTranscript } from './ConversationViews';
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
