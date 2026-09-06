import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { buildConversationSnapshot } from './conversation';
import { generatedDocuments } from './generated-documents';
import { ChatTranscript } from './ConversationViews';

vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

function snapshot(name: string, input: unknown, ok: boolean) {
  const messages: Message[] = [
    { id: 'u', role: 'user', createdAt: '2026-09-06T00:00:00Z', content: [{ type: 'text', text: '输出 HTML 文档' }] },
    { id: 'a', role: 'assistant', createdAt: '2026-09-06T00:00:01Z', content: [{ type: 'tool_call', call: { id: 'c', name, input } }] },
    { id: 't', role: 'tool', createdAt: '2026-09-06T00:00:02Z', content: [{ type: 'tool_result', result: { callId: 'c', ok, content: ok ? 'Created' : 'Denied' } }] }
  ];
  return buildConversationSnapshot({ messages });
}

describe('generated documents in stored conversations', () => {
  it.each(['create_document', 'write_file'])('renders %s without requiring a markdown link', (name) => {
    const content = '<h1>Saved report</h1>';
    const input = name === 'write_file' ? { path: '/workspace/report.html', content } : { name: 'report.html', content };
    const stored = snapshot(name, input, true);
    expect(generatedDocuments(stored.turns[0]!.nodes)).toEqual([{ id: expect.any(String), name: 'report.html', content }]);
    const html = renderToStaticMarkup(React.createElement(ChatTranscript, { snapshot: stored, running: false, turnStartedAt: null }));
    expect(html).toContain('下载保存');
    expect(html).toContain('sandbox=""');
    expect(html).toContain('Content-Security-Policy');
  });

  it('does not offer failed writes, unrelated tools, or non-HTML source files as documents', () => {
    for (const [name, input, ok] of [
      ['write_file', { path: 'report.html', content: '<h1>Failed</h1>' }, false],
      ['read_file', { path: 'report.html', content: '<h1>Read</h1>' }, true],
      ['write_file', { path: 'app.ts', content: 'code' }, true]
    ] as const) {
      expect(generatedDocuments(snapshot(name, input, ok).turns[0]!.nodes)).toEqual([]);
    }
  });
});
