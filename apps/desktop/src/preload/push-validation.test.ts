import { describe, expect, it } from 'vitest';
import { parseAgentPush, parseBrowserDockPush, parseBrowserSecretPush, parseConversationMessageCreatedPush, parseSchedulePush, parseTerminalSecretPush } from './push-validation';

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
    expect(parseTerminalSecretPush({ requestId: 'r', name: 'TOKEN', value: 'leak' })).toBeNull();
    expect(parseTerminalSecretPush({ requestId: 'r', name: 'TOKEN' })).toEqual({ requestId: 'r', name: 'TOKEN' });
  });

  it('validates scheduler events before exposing them to the renderer', () => {
    expect(parseSchedulePush({ type: 'schedule.deleted', scheduleId: 'sch_1' }))
      .toEqual({ type: 'schedule.deleted', scheduleId: 'sch_1' });
    expect(parseSchedulePush({ type: 'schedule.deleted', scheduleId: 'sch_1', target: 'leak' })).toBeNull();
  });

  it('validates persisted conversation delivery notifications', () => {
    const event = { sessionId: 's1', messageId: 'm1', scheduleId: 'sch1', scheduleRunId: 'sr1' };
    expect(parseConversationMessageCreatedPush(event)).toEqual(event);
    expect(parseConversationMessageCreatedPush({ ...event, sessionId: '' })).toBeNull();
  });
});
