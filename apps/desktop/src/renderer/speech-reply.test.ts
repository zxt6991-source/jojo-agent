import { describe, expect, it } from 'vitest';
import { SpeechReplyGate } from './speech-reply';

const reply = { sessionId: 'session-a', messageId: 'message-final', runId: 'run-complete' };
const context = { sessionId: 'session-a', enabled: true, autoReadReplies: true, allowPlayback: true, generation: 4 };

describe('committed reply automatic reading', () => {
  it('reads the exact submitted final message once and marks it automatic', () => {
    const gate = new SpeechReplyGate();
    expect(gate.accept(reply, context)).toEqual({ sessionId: 'session-a', messageId: 'message-final', generation: 4, automatic: true });
    expect(gate.accept(reply, { ...context, generation: 5 })).toBeUndefined();
  });
  it('rejects an old session and does not replay its receipt after switching back', () => {
    const gate = new SpeechReplyGate();
    expect(gate.accept(reply, { ...context, sessionId: 'session-b', generation: 5 })).toBeUndefined();
    expect(gate.accept(reply, { ...context, generation: 6 })).toBeUndefined();
  });
  it.each([{ enabled: false }, { autoReadReplies: false }, { allowPlayback: false }])('respects current preference and active microphone: %o', change => {
    expect(new SpeechReplyGate().accept(reply, { ...context, ...change })).toBeUndefined();
  });
});
