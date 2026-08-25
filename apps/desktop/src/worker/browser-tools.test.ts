import type { PermissionGate, ToolCall, WorkerMessage } from '@desktop-agent/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPermissionGate, BrowserToolBridge } from './browser-tools';

const base: PermissionGate = {
  check: async () => ({ decision: 'allow' })
};
const context = { sessionId: 'session-1', workingDirectory: '/workspace' };

function call(name: string, input: unknown): ToolCall {
  return { id: crypto.randomUUID(), name, input };
}

describe('BrowserPermissionGate', () => {
  it('allows configured navigation but asks for unlisted domains and page mutations', async () => {
    const gate = new BrowserPermissionGate(base, () => ({ enabled: true, allowedDomains: ['*.example.com'] }));
    await expect(gate.check(call('browser_open', { url: 'https://app.example.com/' }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_new_page', { url: 'https://docs.example.com/' }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_open', { url: 'https://other.example/' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_new_page', { url: 'https://other.example/' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_close_page', { pageId: 7 }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_record_start', { name: 'Checkout' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_replay', { recordingId: 'r1' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_record_stop', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_record_cancel', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_recordings', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_record_get', { recordingId: 'github-search' }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_record_delete', { recordingId: 'github-search' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_replay', { recordingId: 'github-search', params: { keyword: 'jojo' } }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_type', { selector: '#email', text: 'hello' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_click', { ref: 'e12' }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Click browser element e12' }
    });
    await expect(gate.check(call('browser_hover', { ref: 'e4' }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Hover browser element e4' }
    });
    await expect(gate.check(call('browser_eval', { js: 'document.title' }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Evaluate JavaScript in the controlled browser page' }
    });
    await expect(gate.check(call('browser_cookies', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_cookies', { includeValues: true }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Read controlled-browser cookie values' }
    });
    await expect(gate.check(call('browser_press', { selector: '#email', key: 'Enter' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_select', { selector: '#country', values: ['CN'] }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_upload', { selector: '#attachment', paths: ['report.pdf'] }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_read', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_pages', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_select_page', { pageId: 7 }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_wait', { selector: '#ready' }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_scroll', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_back', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_reload', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_console', { level: 'error' }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_network', { failedOnly: true }), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_errors', {}), context)).resolves.toEqual({ decision: 'allow' });
  });

  it('asks before attaching an existing Chrome tab', async () => {
    const gate = new BrowserPermissionGate(base, () => ({ enabled: true, allowedDomains: [], mode: 'chrome' }));
    await expect(gate.check(call('browser_select_page', { pageId: 3 }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Attach Chrome tab 3' }
    });
    await expect(gate.check(call('browser_pages', {}), context)).resolves.toEqual({ decision: 'allow' });
  });

  it('includes the resolved recording source, domains, and effects in replay approval', async () => {
    const gate = new BrowserPermissionGate(
      base,
      () => ({ enabled: true, allowedDomains: [] }),
      async () => 'Source: project (untrusted)\nDomains: example.com\nEffects: type credentials, download report'
    );
    await expect(gate.check(call('browser_replay', { recordingId: 'monthly-report' }), context)).resolves.toMatchObject({
      decision: 'ask',
      request: { reason: expect.stringContaining('Effects: type credentials, download report') }
    });
  });

  it('denies browser calls when disabled and delegates non-browser tools', async () => {
    const gate = new BrowserPermissionGate(base, () => ({ enabled: false, allowedDomains: [] }));
    await expect(gate.check(call('browser_read', {}), context)).resolves.toMatchObject({ decision: 'deny', code: 'browser_disabled' });
    await expect(gate.check(call('read_file', { path: 'README.md' }), context)).resolves.toEqual({ decision: 'allow' });
  });

  it('publishes the expanded browser action catalog with bounded schemas', () => {
    const bridge = new BrowserToolBridge(() => undefined, () => ({ enabled: true, allowedDomains: [] }));
    expect(bridge.tools().map((tool) => tool.definition.name)).toEqual([
      'browser_open', 'browser_new_page', 'browser_pages', 'browser_select_page', 'browser_close_page',
      'browser_record_start', 'browser_record_stop', 'browser_record_cancel', 'browser_recordings',
      'browser_record_get', 'browser_record_delete', 'browser_replay',
      'browser_read', 'browser_eval', 'browser_wait', 'browser_scroll', 'browser_click', 'browser_hover', 'browser_type',
      'browser_press', 'browser_select', 'browser_upload', 'browser_back', 'browser_reload', 'browser_screenshot',
      'browser_download', 'browser_downloads', 'browser_console', 'browser_network', 'browser_errors', 'browser_cookies'
    ]);
    for (const tool of bridge.tools()) {
      expect(tool.definition.inputSchema, tool.definition.name).toMatchObject({ type: 'object' });
      expect(tool.definition.inputSchema, tool.definition.name).not.toHaveProperty('oneOf');
      expect(tool.definition.inputSchema, tool.definition.name).not.toHaveProperty('anyOf');
      expect(tool.definition.inputSchema, tool.definition.name).not.toHaveProperty('not');
    }
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_wait')?.definition.inputSchema)
      .toMatchObject({
        type: 'object',
        properties: {
          ref: { type: 'string' }, selector: { type: 'string' },
          frame: { type: 'object', properties: { selectors: { type: 'array', maxItems: 16 } } }
        },
        additionalProperties: false
      });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_read')?.definition.inputSchema)
      .toMatchObject({ properties: { frame: { type: 'object' } }, additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_replay')?.definition.inputSchema)
      .toMatchObject({ required: ['recordingId'], additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_record_start')?.definition.inputSchema)
      .toMatchObject({ properties: { mode: { enum: ['agent_trace', 'user_demo'] } }, additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_console')?.definition.inputSchema)
      .toMatchObject({ additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_network')?.definition.inputSchema)
      .toMatchObject({ additionalProperties: false });
  });

  it('forwards browser replay progress through the active tool context', async () => {
    let request: Extract<WorkerMessage, { type: 'browser.request' }> | undefined;
    const bridge = new BrowserToolBridge((message) => {
      if (message.type === 'browser.request') request = message;
    }, () => ({ enabled: true, allowedDomains: [] }));
    const progress = vi.fn();
    const replay = bridge.tools().find((tool) => tool.definition.name === 'browser_replay');
    const pending = replay!.execute({ recordingId: 'r1' }, {
      sessionId: 'session-1', workingDirectory: '/workspace', approved: true,
      signal: new AbortController().signal, onProgress: progress
    });
    expect(request).toBeDefined();
    bridge.progress(request!.requestId, '→ 1/2 open login');
    bridge.resolve(request!.requestId, { callId: 'browser', ok: true, content: 'done' });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(progress).toHaveBeenCalledWith('→ 1/2 open login');
  });

  it('cancels the main-process browser request when its tool signal aborts', async () => {
    const messages: Array<Extract<WorkerMessage, { type: 'browser.request' | 'browser.cancel' }>> = [];
    const bridge = new BrowserToolBridge((message) => messages.push(message), () => ({ enabled: true, allowedDomains: [] }));
    const replay = bridge.tools().find((tool) => tool.definition.name === 'browser_replay')!;
    const controller = new AbortController();
    const pending = replay.execute({ recordingId: 'r1' }, {
      sessionId: 'session-1', workingDirectory: '/workspace', approved: true,
      signal: controller.signal, onProgress: () => undefined
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ type: 'browser.cancel', requestId: messages[0]!.requestId });
  });
});
