import { z } from 'zod';

const id = z.string().min(1).max(256);
const timestamp = z.string().datetime();
export const ConversationMapScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), workingDirectory: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('personal_main') }).strict()
]);
export type ConversationMapScope = z.infer<typeof ConversationMapScopeSchema>;
export const ConversationMapRequestSchema = z.object({
  range: z.enum(['7d', '30d', '90d']), scope: ConversationMapScopeSchema
}).strict();
export type ConversationMapRequest = z.infer<typeof ConversationMapRequestSchema>;
export const ConversationMapGenerateInputSchema = ConversationMapRequestSchema.extend({ requestId: id, currentSessionId: id.optional() }).strict();
export type ConversationMapGenerateInput = z.infer<typeof ConversationMapGenerateInputSchema>;
export const ConversationMapCancelInputSchema = z.object({ requestId: id }).strict();
export type ConversationMapCancelInput = z.infer<typeof ConversationMapCancelInputSchema>;
export const ConversationMapSourceInputSchema = z.object({ requestId: id, sessionId: id, entryId: id }).strict();
export type ConversationMapSourceInput = z.infer<typeof ConversationMapSourceInputSchema>;

export const MessageReferenceSchema = z.object({
  sessionId: id, entryId: id, seq: z.number().int().nonnegative(), createdAt: timestamp,
  role: z.enum(['user', 'assistant'])
}).strict();
export type MessageReference = z.infer<typeof MessageReferenceSchema>;
export const ConversationMapMessageSchema = z.object({
  reference: MessageReferenceSchema, text: z.string().min(1).max(3000), truncated: z.boolean()
}).strict();
export type ConversationMapMessage = z.infer<typeof ConversationMapMessageSchema>;
export const ConversationTurnRecordSchema = z.object({
  sessionId: id, turnId: id, createdAt: timestamp, user: ConversationMapMessageSchema,
  assistants: z.array(ConversationMapMessageSchema).max(20), truncated: z.boolean()
}).strict();
export type ConversationTurnRecord = z.infer<typeof ConversationTurnRecordSchema>;
export type TurnRecord = ConversationTurnRecord;

export const ConversationStepSchema = z.object({
  id, topicId: id, occurredAt: timestamp, kind: z.enum(['question', 'answer', 'followup', 'revision']),
  text: z.string().min(1).max(160), references: z.array(MessageReferenceSchema).min(1).max(20)
}).strict();
export type ConversationStep = z.infer<typeof ConversationStepSchema>;
export const ConversationLinkSchema = z.object({
  from: id, to: id, relation: z.enum(['sequence', 'followup', 'revision', 'related'])
}).strict();
export type ConversationLink = z.infer<typeof ConversationLinkSchema>;
export const ConversationTopicSchema = z.object({
  id, title: z.string().min(1).max(80), summary: z.string().max(600),
  keywords: z.array(z.string().min(1).max(60)).max(12),
  subtopics: z.array(z.string().min(1).max(100)).max(12),
  steps: z.array(ConversationStepSchema).min(1).max(20), links: z.array(ConversationLinkSchema).max(60)
}).strict();
export type ConversationTopic = z.infer<typeof ConversationTopicSchema>;
export const ConversationMapResultV1Schema = z.object({
  version: z.literal(1), generatedAt: timestamp, rangeStart: timestamp, rangeEnd: timestamp,
  scopeKind: z.enum(['project', 'personal_main']),
  analyzedTurnCount: z.number().int().min(0).max(800), analyzedSessionCount: z.number().int().min(0).max(800),
  modelCallCount: z.number().int().min(0).max(160).optional(),
  omittedStepCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean(), omittedTurnCount: z.number().int().nonnegative().optional(),
  topics: z.array(ConversationTopicSchema).max(12)
}).strict();
export type ConversationMapResultV1 = z.infer<typeof ConversationMapResultV1Schema>;

const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
const evidenceKey = (reference: MessageReference) => JSON.stringify([reference.sessionId, reference.entryId]);
export const QuoteEvidenceSchema = z.object({
  reference: MessageReferenceSchema, quote: nonblank(3000)
}).strict();
export type QuoteEvidence = z.infer<typeof QuoteEvidenceSchema>;
export const EventTypeSchema = z.enum(['exploration', 'position', 'constraint', 'option', 'decision', 'revision', 'action', 'open_question']);
export type EventType = z.infer<typeof EventTypeSchema>;
export const IntentStateSchema = z.enum(['exploring', 'considering', 'planned', 'decided', 'reported_done', 'rejected', 'unknown']);
export type IntentState = z.infer<typeof IntentStateSchema>;

export const EvolutionEventSchema = z.object({
  id, topicId: id, subjectKey: nonblank(160), dimensionKey: nonblank(160),
  eventType: EventTypeSchema, speaker: z.enum(['user', 'assistant']), state: IntentStateSchema,
  claim: nonblank(240), occurredAt: timestamp, evidence: z.array(QuoteEvidenceSchema).min(1).max(20),
  summary: nonblank(120).optional(), subjectLabel: nonblank(80).optional(), dimensionLabel: nonblank(80).optional(),
  truncatedSource: z.boolean()
}).strict().superRefine((event, ctx) => {
  const earliest = Math.min(...event.evidence.map(item => Date.parse(item.reference.createdAt)));
  if (Date.parse(event.occurredAt) !== earliest) {
    ctx.addIssue({ code: 'custom', path: ['occurredAt'], message: 'Event time must be the earliest source timestamp' });
  }
  const quotes = new Set<string>();
  for (const [index, item] of event.evidence.entries()) {
    if (item.reference.role !== event.speaker) {
      ctx.addIssue({ code: 'custom', path: ['evidence', index], message: 'Evidence role must match event speaker' });
    }
    const key = JSON.stringify([evidenceKey(item.reference), item.quote]);
    if (quotes.has(key)) ctx.addIssue({ code: 'custom', path: ['evidence', index], message: 'Duplicate evidence' });
    quotes.add(key);
  }
  if (event.speaker !== 'user' && (['decision', 'revision', 'action'].includes(event.eventType)
      || ['planned', 'decided', 'reported_done', 'rejected'].includes(event.state))) {
    ctx.addIssue({ code: 'custom', path: ['speaker'], message: 'User decisions, revisions and actions require user evidence' });
  }
  if (event.eventType === 'decision' && !['decided', 'rejected'].includes(event.state)) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'A decision must be explicitly decided or rejected' });
  }
  if (event.eventType === 'action' && event.state !== 'reported_done') {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'An action requires a report of completion' });
  }
  if (event.state === 'reported_done' && event.eventType !== 'action') {
    ctx.addIssue({ code: 'custom', path: ['eventType'], message: 'A completion report must be an action event' });
  }
});
export type EvolutionEvent = z.infer<typeof EvolutionEventSchema>;

export const EvolutionChangeSchema = z.object({
  id, topicId: id, fromEventId: id, toEventId: id,
  relation: z.enum(['continued', 'refined', 'revised', 'rejected']), explanation: nonblank(240),
  reasonEvidence: z.array(QuoteEvidenceSchema).min(1).max(20).optional()
}).strict().superRefine((change, ctx) => {
  if (change.fromEventId === change.toEventId) {
    ctx.addIssue({ code: 'custom', path: ['toEventId'], message: 'Change endpoints must differ' });
  }
  for (const [index, item] of (change.reasonEvidence ?? []).entries()) {
    if (item.reference.role !== 'user') {
      ctx.addIssue({ code: 'custom', path: ['reasonEvidence', index], message: 'Change reasons require direct user evidence' });
    }
  }
});
export type EvolutionChange = z.infer<typeof EvolutionChangeSchema>;

export const TopicInsightSchema = z.object({
  id, kind: z.enum(['key_change', 'current_state', 'open_question']), text: nonblank(240),
  supportingEventIds: z.array(id).max(20), supportingChangeIds: z.array(id).max(40)
}).strict().superRefine((insight, ctx) => {
  if (insight.supportingEventIds.length + insight.supportingChangeIds.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'An insight requires supporting evidence' });
  }
  if (insight.kind === 'key_change' && insight.supportingChangeIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['supportingChangeIds'], message: 'A key change insight requires a verified change' });
  }
  for (const field of ['supportingEventIds', 'supportingChangeIds'] as const) {
    if (new Set(insight[field]).size !== insight[field].length) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate insight support ID' });
    }
  }
});
export type TopicInsight = z.infer<typeof TopicInsightSchema>;

// Timestamps alone cannot order equal-time messages from different sessions.
function precedes(from: EvolutionEvent, to: EvolutionEvent): boolean {
  return from.evidence.every(({ reference: a }) => to.evidence.every(({ reference: b }) => {
    const difference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return a.sessionId === b.sessionId ? a.seq < b.seq && difference >= 0 : difference > 0;
  }));
}

export const ConversationTopicV2Schema = z.object({
  id, title: nonblank(80), summary: z.string().max(600),
  events: z.array(EvolutionEventSchema).min(1).max(20), changes: z.array(EvolutionChangeSchema).max(40),
  insights: z.array(TopicInsightSchema).max(20), visibleEventIds: z.array(id).min(1).max(8)
}).strict().superRefine((topic, ctx) => {
  const events = new Map(topic.events.map(event => [event.id, event]));
  const changes = new Map(topic.changes.map(change => [change.id, change]));
  const visible = new Set(topic.visibleEventIds);
  const ids = new Set<string>([topic.id]);
  for (const field of ['events', 'changes', 'insights'] as const) {
    for (const [index, item] of topic[field].entries()) {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: [field, index, 'id'], message: 'Duplicate ID' });
      ids.add(item.id);
      if ('topicId' in item && item.topicId !== topic.id) {
        ctx.addIssue({ code: 'custom', path: [field, index, 'topicId'], message: 'Item must belong to its topic' });
      }
    }
  }
  if (visible.size !== topic.visibleEventIds.length || topic.visibleEventIds.some(value => !events.has(value))) {
    ctx.addIssue({ code: 'custom', path: ['visibleEventIds'], message: 'Visible event IDs must be unique and belong to this topic' });
  }
  for (const [index, change] of topic.changes.entries()) {
    const from = events.get(change.fromEventId);
    const to = events.get(change.toEventId);
    if (!from || !to) {
      ctx.addIssue({ code: 'custom', path: ['changes', index], message: 'Change endpoints must belong to this topic' });
      continue;
    }
    const fromSources = new Set(from.evidence.map(item => evidenceKey(item.reference)));
    const independent = to.evidence.every(item => !fromSources.has(evidenceKey(item.reference)));
    if (!precedes(from, to) || !independent || from.subjectKey !== to.subjectKey || from.dimensionKey !== to.dimensionKey
        || from.truncatedSource || to.truncatedSource) {
      ctx.addIssue({ code: 'custom', path: ['changes', index], message: 'Changes require chronological, independent, complete evidence for the same subject and dimension' });
    }
    if (visible.has(from.id) !== visible.has(to.id)) {
      ctx.addIssue({ code: 'custom', path: ['visibleEventIds'], message: 'Visible change endpoints must be retained together' });
    }
  }
  for (const [index, insight] of topic.insights.entries()) {
    if (insight.supportingEventIds.some(value => !events.has(value)) || insight.supportingChangeIds.some(value => !changes.has(value))) {
      ctx.addIssue({ code: 'custom', path: ['insights', index], message: 'Insight support must belong to this topic' });
    }
  }
});
export type ConversationTopicV2 = z.infer<typeof ConversationTopicV2Schema>;

export const ConversationMapResultV2Schema = z.object({
  version: z.literal(2), generatedAt: timestamp, rangeStart: timestamp, rangeEnd: timestamp,
  scopeKind: z.enum(['project', 'personal_main']),
  analyzedTurnCount: z.number().int().min(0).max(800), analyzedSessionCount: z.number().int().min(0).max(800),
  modelCallCount: z.number().int().min(0).max(160), truncated: z.boolean(),
  omittedTurnCount: z.number().int().min(0).max(800).optional(),
  omittedEventCount: z.number().int().nonnegative(), topics: z.array(ConversationTopicV2Schema).max(12)
}).strict().superRefine((result, ctx) => {
  const start = Date.parse(result.rangeStart);
  const end = Date.parse(result.rangeEnd);
  if (start >= end) ctx.addIssue({ code: 'custom', path: ['rangeEnd'], message: 'Invalid date range' });
  const ids = new Set<string>();
  for (const [index, topic] of result.topics.entries()) {
    for (const item of [topic, ...topic.events, ...topic.changes, ...topic.insights]) {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: ['topics', index], message: 'IDs must be globally unique' });
      ids.add(item.id);
    }
    const evidence = [...topic.events.flatMap(event => event.evidence), ...topic.changes.flatMap(change => change.reasonEvidence ?? [])];
    if (evidence.some(item => Date.parse(item.reference.createdAt) < start || Date.parse(item.reference.createdAt) >= end)) {
      ctx.addIssue({ code: 'custom', path: ['topics', index], message: 'Evidence must fall within the selected history range' });
    }
  }
});
export type ConversationMapResultV2 = z.infer<typeof ConversationMapResultV2Schema>;
export const ConversationMapResultSchema = z.discriminatedUnion('version', [ConversationMapResultV1Schema, ConversationMapResultV2Schema]);
export type ConversationMapResult = z.infer<typeof ConversationMapResultSchema>;
export const ConversationMapEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation-map.progress'), requestId: id,
    phase: z.enum(['reading', 'extracting', 'merging', 'comparing', 'rendering']),
    completed: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('conversation-map.completed'), requestId: id, result: ConversationMapResultSchema }).strict(),
  z.object({ type: z.literal('conversation-map.failed'), requestId: id, code: z.string().min(1).max(128), message: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('conversation-map.cancelled'), requestId: id }).strict()
]);
export type ConversationMapEvent = z.infer<typeof ConversationMapEventSchema>;
export const ConversationMapSourceResultSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), reference: MessageReferenceSchema, messageId: id,
    text: z.string().max(3000), truncated: z.boolean() }).strict()
]);
export type ConversationMapSourceResult = z.infer<typeof ConversationMapSourceResultSchema>;

// Internal reader contracts. The allowed session IDs are always a separate,
// required backend argument and can never be supplied by a renderer query.
export const ConversationMapHistoryCursorSchema = z.object({ createdAt: timestamp, sessionId: id, seq: z.number().int().nonnegative() }).strict();
export const ConversationMapHistoryQuerySchema = z.object({
  rangeStart: timestamp, rangeEnd: timestamp, scope: ConversationMapScopeSchema,
  cursor: ConversationMapHistoryCursorSchema.optional(), limit: z.number().int().min(1).max(100)
}).strict().refine(value => Date.parse(value.rangeStart) < Date.parse(value.rangeEnd), { message: 'Invalid date range' });
export type ConversationMapHistoryQuery = z.infer<typeof ConversationMapHistoryQuerySchema>;
export const ConversationMapHistoryPageSchema = z.object({
  turns: z.array(ConversationTurnRecordSchema).max(100), nextCursor: ConversationMapHistoryCursorSchema.optional(), hasMore: z.boolean()
}).strict();
export type ConversationMapHistoryPage = z.infer<typeof ConversationMapHistoryPageSchema>;
export type ConversationTurnPageQuery = ConversationMapHistoryQuery;
export type ConversationTurnPage = ConversationMapHistoryPage;
