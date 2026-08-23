import { z } from 'zod';
import { MemoryKindSchema } from './memory.js';

export const MemoryCandidateStateSchema = z.enum([
  'pending', 'accepted', 'rejected', 'expired', 'superseded'
]);
export type MemoryCandidateState = z.infer<typeof MemoryCandidateStateSchema>;

export const MemoryCandidateProvenanceSchema = z.object({
  source: z.enum(['user', 'assistant', 'tool', 'runtime', 'subagent', 'workflow']),
  sourceId: z.string().min(1).max(512).optional(),
  verified: z.boolean()
});
export type MemoryCandidateProvenance = z.infer<typeof MemoryCandidateProvenanceSchema>;

const CandidateExtractionItemBaseSchema = z.object({
  scope: z.enum(['global', 'project']),
  kind: MemoryKindSchema,
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().min(1).max(2 * 1024),
  rationale: z.string().trim().min(1).max(1_024),
  confidence: z.enum(['high', 'medium', 'low']),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  suggestedTarget: z.enum(['index', 'topic', 'scratchpad']).default('index'),
  ruleTriggers: z.array(z.string().trim().min(1).max(100)).max(20).optional()
});

export const CandidateExtractionItemSchema = CandidateExtractionItemBaseSchema.superRefine((value, context) => {
  if (value.kind !== 'rule' && value.ruleTriggers !== undefined) {
    context.addIssue({ code: 'custom', message: 'ruleTriggers are only valid for rule candidates.' });
  }
});
export type CandidateExtractionItem = z.infer<typeof CandidateExtractionItemSchema>;

export const CandidateExtractionResultSchema = z.object({
  candidates: z.array(CandidateExtractionItemSchema).max(3)
});
export type CandidateExtractionResult = z.infer<typeof CandidateExtractionResultSchema>;

export const MemoryCandidateSchema = CandidateExtractionItemBaseSchema.omit({ ruleTriggers: true }).extend({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  operationId: z.string().min(1),
  scopeId: z.string().min(1),
  state: MemoryCandidateStateSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  provenance: z.array(MemoryCandidateProvenanceSchema).min(1).max(20),
  rule: z.object({ triggers: z.array(z.string().trim().min(1).max(100)).max(20).optional() }).optional(),
  suggestedMutation: z.discriminatedUnion('type', [
    z.object({ type: z.literal('create') }),
    z.object({
      type: z.literal('update'),
      existingMemoryId: z.string().min(1),
      expectedHashAtProposal: z.string().regex(/^[a-f0-9]{64}$/u)
    })
  ]),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  resolvedAt: z.number().int().nonnegative().optional()
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MemoryCandidateReviewEditSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  content: z.string().trim().min(1).max(2 * 1024).optional(),
  scope: z.enum(['global', 'project']).optional(),
  kind: MemoryKindSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  suggestedTarget: z.enum(['index', 'topic', 'scratchpad']).optional(),
  ruleTriggers: z.array(z.string().trim().min(1).max(100)).max(20).optional()
});
export type MemoryCandidateReviewEdit = z.infer<typeof MemoryCandidateReviewEditSchema>;
