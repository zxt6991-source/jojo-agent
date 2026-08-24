import { describe, expect, it } from 'vitest';
import { parseAgentPush, parseBrowserDockPush, parseBrowserSecretPush } from './push-validation';

describe('preload push validation', () => {
  it('drops malformed agent events', () => {
    expect(parseAgentPush({ type: 'text.delta', text: 42 })).toBeNull();
    expect(parseAgentPush({ type: 'turn.cancelled', unexpected: true })).toBeNull();
  });

  it('accepts valid agent events', () => {
    expect(parseAgentPush({ type: 'text.delta', text: 'hello' })).toEqual({ type: 'text.delta', text: 'hello' });
  });

  it('distinguishes a valid null dock state from malformed input', () => {
    expect(parseBrowserDockPush(null)).toBeNull();
    expect(parseBrowserDockPush({ sessionId: 'a' })).toBeUndefined();
  });

  it('rejects unknown fields in secret requests', () => {
    expect(parseBrowserSecretPush({ requestId: 'r', name: 'token', secret: 'leak' })).toBeNull();
  });
});
