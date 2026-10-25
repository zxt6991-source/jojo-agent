import { z } from 'zod';
import { EventTypeSchema, IntentStateSchema } from '@desktop-agent/contracts';

/** These details are authored locally, never copied from the model response. */
export class ConversationMapOutputError extends Error {
  constructor(readonly detail: string, readonly kind: 'reference' | 'size' = 'reference') { super('Invalid conversation-map output'); }
}

export function parseConversationMapJson(raw: string): unknown {
  if (raw.length > 128_000) throw new ConversationMapOutputError('Response exceeds the size limit. Return fewer events.', 'size');
  const text = raw.trim();
  // Accept only a single complete JSON code block, never prose with embedded JSON.
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(text);
  return JSON.parse(fenced ? fenced[1]! : text);
}

const fields = new Set(['events', 'topicLabel', 'subjectLabel', 'dimensionLabel', 'eventType', 'speaker', 'state', 'claim',
  'evidence', 'evidenceId', 'exactQuote', 'groups', 'memberIds', 'changes', 'fromEventId', 'toEventId', 'relation', 'reviews', 'eventId', 'supported']);
const enumValues: Record<string, readonly string[]> = {
  eventType: EventTypeSchema.options, state: IntentStateSchema.options, speaker: ['user', 'assistant'],
  relation: ['continued', 'refined', 'revised', 'rejected', 'uncertain']
};
const localizedEventTypes: Record<string, string> = {
  探索: 'exploration', 观点: 'position', 新约束: 'constraint', 方案: 'option', 决定: 'decision', 修订: 'revision', 执行反馈: 'action', 待解决: 'open_question'
};

/** Accept spelling/display-label variants, never guess a new semantic classification. */
export function normalizeConversationMapExtraction(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('events' in value) || !Array.isArray(value.events)) return value;
  return { ...value, events: value.events.map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.eventType !== 'string') return event;
    const label = event.eventType.trim();
    const normalized = Object.hasOwn(localizedEventTypes, label) ? localizedEventTypes[label]! : label.toLowerCase().replace(/[\s-]+/gu, '_');
    return EventTypeSchema.safeParse(normalized).success ? { ...event, eventType: normalized } : event;
  }) };
}
function safePath(path: PropertyKey[]): string {
  return path.map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 ? `[${part}]`
    : typeof part === 'string' && fields.has(part) ? `.${part}` : '.?').join('').replace(/^\./u, '') || 'response';
}

/** Zod messages and unknown keys can include model text: emit only known paths and rules. */
export function conversationMapValidationFeedback(error: unknown): { detail: string; message: string } {
  if (error instanceof ConversationMapOutputError) return {
    detail: error.detail, message: error.kind === 'size'
      ? '模型返回内容过长，已重试仍超出处理上限。请缩小范围或切换模型后重试。'
      : '模型返回的原文引用未通过校验，已重试仍无法匹配。请缩小范围或切换模型后重试。'
  };
  if (error instanceof SyntaxError) return {
    detail: 'Return one complete valid JSON object, without prose or Markdown.',
    message: '模型未返回可解析的 JSON，已重试仍无法修复。请切换模型后重试。'
  };
  if (error instanceof z.ZodError) {
    const detail = error.issues.slice(0, 6).map(issue => {
      const field = issue.path.at(-1);
      const allowed = typeof field === 'string' && Object.hasOwn(enumValues, field) ? enumValues[field] : undefined;
      const rule = issue.code === 'too_big' ? `must contain at most ${issue.maximum} characters/items`
        : issue.code === 'too_small' ? `must contain at least ${issue.minimum} characters/items`
          : issue.code === 'unrecognized_keys' ? 'remove all fields not defined in the schema'
            : issue.code === 'invalid_value' ? `choose exactly one of the allowed enum values${allowed ? `: ${JSON.stringify(allowed)}` : ' from the schema'}`
              : 'use the required type and fields from the schema';
      return `${safePath(issue.path)}: ${rule}`;
    }).join('; ');
    return { detail, message: `模型返回的字段不符合要求（${safePath(error.issues[0]?.path ?? [])}），重试后仍无可用内容。请缩小时间或项目范围后重试，或切换分析模型。` };
  }
  return { detail: 'Follow the schema exactly and cite only the provided IDs.', message: '模型返回的结构或原文引用无效，请重试。' };
}
