import { z } from 'zod';
import {
  ConversationMapCancelInputSchema, ConversationMapGenerateInputSchema,
  ConversationMapSourceInputSchema, ConversationMapSourceResultSchema, MessageReferenceSchema
} from './conversation-map';

const id = z.string().min(1).max(256);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
export const InsightPerspectiveSchema = z.enum(['conversation_map', 'reverse_thinking', 'second_order', 'blind_spots']);
export type InsightPerspective = z.infer<typeof InsightPerspectiveSchema>;
// Conversation maps retain their compatible, dedicated generation API.
export const InsightAnalysisPerspectiveSchema = z.enum(['reverse_thinking', 'second_order', 'blind_spots']);
export type InsightAnalysisPerspective = z.infer<typeof InsightAnalysisPerspectiveSchema>;
export const ClaimNatureSchema = z.enum(['source_fact', 'model_inference', 'hypothesis', 'suggestion']);
export type ClaimNature = z.infer<typeof ClaimNatureSchema>;
export const InsightGenerateInputSchema = ConversationMapGenerateInputSchema.extend({
  perspective: InsightAnalysisPerspectiveSchema
}).strict();
export type InsightGenerateInput = z.infer<typeof InsightGenerateInputSchema>;
export const InsightCancelInputSchema = ConversationMapCancelInputSchema;
export type InsightCancelInput = z.infer<typeof InsightCancelInputSchema>;
export const InsightSourceInputSchema = ConversationMapSourceInputSchema;
export type InsightSourceInput = z.infer<typeof InsightSourceInputSchema>;
export const InsightSourceResultSchema = ConversationMapSourceResultSchema;
export type InsightSourceResult = z.infer<typeof InsightSourceResultSchema>;

export const InsightCardSchema = z.object({
  id, topicId: id.optional(), title: text(160), explanation: text(1200), nature: ClaimNatureSchema,
  uncertainty: text(600).optional(), verificationQuestion: text(600).optional(),
  supportingEventIds: z.array(id).min(1).max(20),
  supportingReferences: z.array(MessageReferenceSchema).min(1).max(40)
}).strict().superRefine((card, ctx) => {
  if (new Set(card.supportingEventIds).size !== card.supportingEventIds.length) {
    ctx.addIssue({ code: 'custom', path: ['supportingEventIds'], message: 'Duplicate event support' });
  }
  const references = card.supportingReferences.map(reference => JSON.stringify([reference.sessionId, reference.entryId]));
  if (new Set(references).size !== references.length) {
    ctx.addIssue({ code: 'custom', path: ['supportingReferences'], message: 'Duplicate source reference' });
  }
});
export type InsightCard = z.infer<typeof InsightCardSchema>;

export const InsightCoverageSchema = z.object({
  extractedEventCount: z.number().int().min(0).max(1600),
  eligibleEventCount: z.number().int().min(0).max(1600),
  selectedEventCount: z.number().int().min(0).max(60),
  omittedEventCount: z.number().int().nonnegative(), omittedCardCount: z.number().int().min(0).max(20),
  truncatedUserMessageCount: z.number().int().min(0).max(800),
  truncatedAssistantMessageCount: z.number().int().nonnegative(),
  omittedAssistantMessageCount: z.number().int().nonnegative(),
  unknownSourceTruncation: z.boolean(), analysisPerformed: z.boolean(),
  topicGroupingIncomplete: z.boolean().optional(),
  userEventCount: z.number().int().min(0).max(1600).optional(),
  assistantEventCount: z.number().int().min(0).max(1600).optional()
}).strict().superRefine((coverage, ctx) => {
  if (coverage.selectedEventCount > coverage.eligibleEventCount || coverage.eligibleEventCount > coverage.extractedEventCount) {
    ctx.addIssue({ code: 'custom', message: 'Invalid event coverage counts' });
  }
  if (coverage.analysisPerformed !== (coverage.selectedEventCount > 0)) {
    ctx.addIssue({ code: 'custom', path: ['analysisPerformed'], message: 'Analysis must match selected events' });
  }
  if (coverage.userEventCount !== undefined && coverage.eligibleEventCount > coverage.userEventCount) {
    ctx.addIssue({ code: 'custom', path: ['userEventCount'], message: 'Only user events are eligible' });
  }
  if (coverage.userEventCount !== undefined && coverage.assistantEventCount !== undefined
    && coverage.userEventCount + coverage.assistantEventCount !== coverage.extractedEventCount) {
    ctx.addIssue({ code: 'custom', path: ['extractedEventCount'], message: 'Source role counts must match extracted events' });
  }
});
export type InsightCoverage = z.infer<typeof InsightCoverageSchema>;

export const InsightResultSchema = z.object({
  version: z.literal(1), perspective: InsightAnalysisPerspectiveSchema,
  generatedAt: z.string().datetime(), rangeStart: z.string().datetime(), rangeEnd: z.string().datetime(),
  scopeKind: z.enum(['project', 'personal_main']),
  analyzedTurnCount: z.number().int().min(0).max(800), analyzedSessionCount: z.number().int().min(0).max(800),
  truncated: z.boolean(), omittedTurnCount: z.number().int().nonnegative(),
  cards: z.array(InsightCardSchema).max(20), modelCallCount: z.number().int().min(0).max(160),
  semanticCacheHit: z.boolean(),
  coverage: InsightCoverageSchema.optional(),
  emptyReason: z.enum(['no_history', 'no_eligible_events', 'no_supported_insights', 'incomplete_analysis']).optional()
}).strict().superRefine((result, ctx) => {
  const start = Date.parse(result.rangeStart);
  const end = Date.parse(result.rangeEnd);
  if (start >= end) ctx.addIssue({ code: 'custom', path: ['rangeEnd'], message: 'Invalid date range' });
  if (new Set(result.cards.map(card => card.id)).size !== result.cards.length) {
    ctx.addIssue({ code: 'custom', path: ['cards'], message: 'Duplicate card ID' });
  }
  if (result.emptyReason && result.cards.length) ctx.addIssue({ code: 'custom', path: ['emptyReason'], message: 'Only empty results have an empty reason' });
  if (result.emptyReason && !result.coverage) ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'An empty reason requires coverage' });
  if (result.emptyReason === 'no_history' && (result.analyzedTurnCount || result.omittedTurnCount)) ctx.addIssue({ code: 'custom', path: ['emptyReason'], message: 'History is not empty' });
  if (result.coverage && result.emptyReason === 'no_eligible_events' && result.coverage.eligibleEventCount !== 0) ctx.addIssue({ code: 'custom', path: ['emptyReason'], message: 'Eligible events exist' });
  if (result.coverage && result.emptyReason === 'no_supported_insights' && !result.coverage.analysisPerformed) ctx.addIssue({ code: 'custom', path: ['emptyReason'], message: 'Analysis was not performed' });
  if (result.coverage && result.emptyReason && result.emptyReason !== 'no_history') {
    const coverage = result.coverage;
    const incomplete = result.omittedTurnCount > 0 || coverage.omittedEventCount > 0 || coverage.truncatedUserMessageCount > 0
      || coverage.unknownSourceTruncation || coverage.selectedEventCount < coverage.eligibleEventCount || coverage.topicGroupingIncomplete === true;
    if ((result.emptyReason === 'incomplete_analysis') !== incomplete) ctx.addIssue({ code: 'custom', path: ['emptyReason'], message: 'Empty reason conflicts with evidence coverage' });
  }
  for (const [index, card] of result.cards.entries()) {
    if (card.supportingReferences.some(reference => Date.parse(reference.createdAt) < start || Date.parse(reference.createdAt) >= end)) {
      ctx.addIssue({ code: 'custom', path: ['cards', index], message: 'Evidence must fall within the selected history range' });
    }
  }
});
export type InsightResult = z.infer<typeof InsightResultSchema>;
export const InsightEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('insight.progress'), requestId: id,
    phase: z.enum(['reading', 'extracting', 'merging', 'analyzing', 'validating']),
    completed: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
    detail: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ type: z.literal('insight.completed'), requestId: id, result: InsightResultSchema }).strict(),
  z.object({ type: z.literal('insight.failed'), requestId: id, code: z.string().min(1).max(128), message: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('insight.cancelled'), requestId: id }).strict()
]);
export type InsightEvent = z.infer<typeof InsightEventSchema>;
