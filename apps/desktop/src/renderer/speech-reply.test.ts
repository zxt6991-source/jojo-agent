import { describe, expect, it } from 'vitest';
import { SpeechReplyGate } from './speech-reply';

const reply = { sessionId: 'session-a', messageId: 'message-final', runId: 'run-complete', voiceInput: true };
const context = { sessionId: 'session-a', enabled: true, autoReadReplies: true, allowPlayback: true, generation: 4 };

describe('committed reply automatic reading', () => {
  it('honors explicit one-turn consent without requiring or changing automatic reading', () => {
    const gate = new SpeechReplyGate();
    expect(gate.accept({ ...reply, voiceInput: false, requestedReadAloud: true }, { ...context, autoReadReplies: false })).toEqual({ sessionId: reply.sessionId, messageId: reply.messageId, generation: context.generation, automatic: false });
    expect(gate.accept({ ...reply, requestedReadAloud: true }, context)).toBeUndefined();
    expect(new SpeechReplyGate().accept(reply, { ...context, autoReadReplies: false })).toBeUndefined();
  });
  it.each([{ enabled: false }, { allowPlayback: false }, { sessionId: 'other' }])('still gates explicitly requested reading: %o', change => {
    expect(new SpeechReplyGate().accept({ ...reply, requestedReadAloud: true }, { ...context, ...change })).toBeUndefined();
  });
  it('reads the exact submitted final message once and marks it automatic', () => {
    const gate = new SpeechReplyGate();
    expect(gate.accept(reply, context)).toEqual({ sessionId: 'session-a', messageId: 'message-final', generation: 4, automatic: true });
    expect(gate.accept(reply, { ...context, generation: 5 })).toBeUndefined();
  });
  it('keeps ordinary typed replies silent even when automatic voice replies are enabled', () => {
    const typed = { sessionId: reply.sessionId, messageId: reply.messageId, runId: reply.runId };
    expect(new SpeechReplyGate().accept(typed, context)).toBeUndefined();
    expect(new SpeechReplyGate().accept({ ...typed, voiceInput: false }, context)).toBeUndefined();
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
