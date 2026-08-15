import type { PermissionGate, ToolCall } from '@desktop-agent/contracts';
import { describe, expect, it } from 'vitest';
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
    await expect(gate.check(call('browser_recordings', {}), context)).resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('browser_type', { selector: '#email', text: 'hello' }), context)).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(call('browser_click', { ref: 'e12' }), context)).resolves.toMatchObject({
      decision: 'ask', request: { reason: 'Click browser element e12' }
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

  it('denies browser calls when disabled and delegates non-browser tools', async () => {
    const gate = new BrowserPermissionGate(base, () => ({ enabled: false, allowedDomains: [] }));
    await expect(gate.check(call('browser_read', {}), context)).resolves.toMatchObject({ decision: 'deny', code: 'browser_disabled' });
    await expect(gate.check(call('read_file', { path: 'README.md' }), context)).resolves.toEqual({ decision: 'allow' });
  });

  it('publishes the expanded browser action catalog with bounded schemas', () => {
    const bridge = new BrowserToolBridge(() => undefined, () => ({ enabled: true, allowedDomains: [] }));
    expect(bridge.tools().map((tool) => tool.definition.name)).toEqual([
      'browser_open', 'browser_new_page', 'browser_pages', 'browser_select_page', 'browser_close_page',
      'browser_record_start', 'browser_record_stop', 'browser_recordings', 'browser_replay',
      'browser_read', 'browser_wait', 'browser_scroll', 'browser_click', 'browser_type',
      'browser_press', 'browser_select', 'browser_upload', 'browser_back', 'browser_reload', 'browser_screenshot',
      'browser_download', 'browser_downloads', 'browser_console', 'browser_network', 'browser_errors'
    ]);
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_wait')?.definition.inputSchema)
      .toMatchObject({ oneOf: [{ required: ['ref'] }, { required: ['selector'] }], additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_replay')?.definition.inputSchema)
      .toMatchObject({ required: ['recordingId'], additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_console')?.definition.inputSchema)
      .toMatchObject({ additionalProperties: false });
    expect(bridge.tools().find((tool) => tool.definition.name === 'browser_network')?.definition.inputSchema)
      .toMatchObject({ additionalProperties: false });
  });
});
