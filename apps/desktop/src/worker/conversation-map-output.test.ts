import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConversationMapOutputError, conversationMapValidationFeedback, normalizeConversationMapExtraction, parseConversationMapJson } from './conversation-map-output';

describe('conversation-map model output envelopes', () => {
  it.each(['{"events":[]}', '\uFEFF {"events":[]} ', '```json\n{"events":[]}\n```', '```JSON\r\n{"events":[]}\r\n```', '```\n{"events":[]}\n```'])('accepts a complete JSON object with a bounded wrapper', raw => {
    expect(parseConversationMapJson(raw)).toEqual({ events: [] });
  });
  it.each(['Here is your result: {"events":[]}', '```json\n{"events":[]}\n```\nAnd a comment', '```json\n{"events":[]}\n```\n```json\n{"events":[]}\n```', '{"events":[', '{"events":[]} {"events":[]}'])('rejects ambiguous, partial, or prose-wrapped output', raw => {
    expect(() => parseConversationMapJson(raw)).toThrow();
  });
  it('preserves quoted source text exactly when stripping a fence', () => {
    const quote = '保留 `route_id`。\n  不要 自动生成。';
    expect(parseConversationMapJson('```json\n' + JSON.stringify({ quote }) + '\n```')).toEqual({ quote });
  });
  it('keeps oversized response errors distinct from citation mismatches', () => {
    try { parseConversationMapJson(' '.repeat(128_001)); }
    catch (error) {
      expect(conversationMapValidationFeedback(error).message).toContain('内容过长');
      return;
    }
    throw new Error('Expected the response-size guard');
  });
});

describe('safe validation feedback', () => {
  it('lists trusted event enums in repair feedback, without echoing the rejected value', () => {
    const parsed = z.object({ events: z.array(z.object({ eventType: z.enum(['exploration', 'option']) })) }).safeParse({ events: [{ eventType: 'secret-value' }] });
    const feedback = conversationMapValidationFeedback(parsed.error);
    expect(feedback.detail).toContain('events[0].eventType: choose exactly one');
    expect(feedback.detail).toContain('"open_question"');
    expect(JSON.stringify(feedback)).not.toContain('secret-value');
  });
  it('normalizes only recognized type names without mutating the source or dropping unknown fields', () => {
    const value = { events: [
      { eventType: ' OPEN-QUESTION ', evidence: [{ exactQuote: '  保留原文\n不变  ' }], unknownField: true },
      { eventType: '已完成' }, { eventType: 'decision|action' }, { eventType: 'answer' }, { eventType: 'constructor' }
    ], tools: ['untrusted'] };
    const normalized = normalizeConversationMapExtraction(value);
    expect(normalized).toEqual({ ...value, events: [{ ...value.events[0], eventType: 'open_question' }, ...value.events.slice(1)] });
    expect(value.events[0]!.eventType).toBe(' OPEN-QUESTION ');
  });
  it('reports a known field and its limit without returning the invalid value', () => {
    const parsed = z.object({ events: z.array(z.object({ claim: z.string().max(5) }).strict()) }).safeParse({ events: [{ claim: 'secret-value' }] });
    expect(parsed.success).toBe(false);
    const feedback = conversationMapValidationFeedback(parsed.error);
    expect(feedback.detail).toContain('events[0].claim: must contain at most 5');
    expect(JSON.stringify(feedback)).not.toContain('secret-value');
  });
  it('does not echo unexpected field names or raw parser error text', () => {
    const parsed = z.object({ events: z.array(z.object({}).strict()) }).strict().safeParse({ events: [{ 'secret-instruction': true }] });
    const feedback = conversationMapValidationFeedback(parsed.error);
    expect(feedback.detail).toContain('remove all fields not defined');
    expect(JSON.stringify(feedback)).not.toContain('secret-instruction');
    expect(JSON.stringify(conversationMapValidationFeedback(new SyntaxError('secret response body')))).not.toContain('secret response body');
  });
  it('preserves trusted reference feedback and keeps arbitrary errors generic', () => {
    expect(conversationMapValidationFeedback(new ConversationMapOutputError('events[0]: speaker must match.')).detail).toContain('speaker must match');
    expect(JSON.stringify(conversationMapValidationFeedback(new Error('secret diagnostic')))).not.toContain('secret diagnostic');
  });
});
