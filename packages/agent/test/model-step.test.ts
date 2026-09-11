import { describe, expect, it, vi } from 'vitest';
import type { ModelEvent } from '@desktop-agent/contracts';
import { runModelStep } from '../src/model-step.js';

const complete: ModelEvent = { type: 'response_completed', stopReason: 'stop' };
const text: ModelEvent = { type: 'text_delta', text: 'partial' };
const call: ModelEvent = { type: 'tool_call_completed', call: { id: 'one', name: 'write', input: {} } };

function step(events: ModelEvent[], controller = new AbortController(), after?: () => void) {
  return runModelStep({
    model: 'test', messages: [], toolDefinitions: [], signal: controller.signal, emit: vi.fn(),
    provider: { async *stream() { yield* events; after?.(); } }
  });
}

describe('model step completion contract', () => {
  it('rejects an empty provider', async () => {
    await expect(step([])).rejects.toMatchObject({ code: 'empty_response' });
  });
  it.each([[text], [call], [{ type: 'usage', inputTokens: 1 } as ModelEvent]])('requires completion after %j', async (event) => {
    await expect(step([event])).rejects.toMatchObject({ code: 'provider_stream_incomplete' });
  });
  it.each([text, call, complete, { type: 'tool_call_delta', id: 'one', argumentsDelta: '{}' },
    { type: 'response_failed', code: 'network', message: 'late' }] as ModelEvent[])('rejects late %j', async (event) => {
    await expect(step([complete, event])).rejects.toMatchObject({ code: 'provider_protocol_error' });
  });
  it('accepts finish-only and post-completion usage', async () => {
    await expect(step([complete, { type: 'usage', inputTokens: 1 }])).resolves.toEqual({ text: '', calls: [], stopReason: 'stop' });
  });
  it('preserves failure classification and does not return pending calls', async () => {
    await expect(step([call, { type: 'response_failed', code: 'provider_stream_error', message: 'upstream' }]))
      .rejects.toMatchObject({ code: 'provider_stream_error' });
  });
  it('checks cancellation at EOF, including after the last chunk', async () => {
    const controller = new AbortController();
    await expect(step([complete], controller, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
