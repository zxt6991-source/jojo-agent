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
export const ConversationMapResultSchema = z.object({
  version: z.literal(1), generatedAt: timestamp, rangeStart: timestamp, rangeEnd: timestamp,
  scopeKind: z.enum(['project', 'personal_main']),
  analyzedTurnCount: z.number().int().min(0).max(800), analyzedSessionCount: z.number().int().min(0).max(800),
  modelCallCount: z.number().int().min(0).max(160).optional(),
  omittedStepCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean(), omittedTurnCount: z.number().int().nonnegative().optional(),
  topics: z.array(ConversationTopicSchema).max(12)
}).strict();
export type ConversationMapResult = z.infer<typeof ConversationMapResultSchema>;
export const ConversationMapEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation-map.progress'), requestId: id,
    phase: z.enum(['reading', 'extracting', 'merging', 'rendering']),
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
