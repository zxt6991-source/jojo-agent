import { z } from 'zod';
export const SessionSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  source: z.enum(['main', 'scheduler', 'team', 'spawn', 'all']).default('main')
}).strict();
export type SessionSearchQuery = z.infer<typeof SessionSearchQuerySchema>;
export const SessionSearchHitSchema = z.object({
  sessionId: z.string(), entryId: z.string(), seq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), role: z.enum(['user', 'assistant']),
  source: z.enum(['main', 'scheduler', 'team', 'spawn']), project: z.string().optional(),
  snippet: z.string().max(1600), score: z.number()
}).strict();
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;
export const SessionReadWindowQuerySchema = z.object({
  sessionId: z.string().min(1).max(256), anchorSeq: z.coerce.number().int().nonnegative(),
  before: z.coerce.number().int().min(0).max(10).default(2),
  after: z.coerce.number().int().min(0).max(10).default(2),
  maxCharacters: z.coerce.number().int().min(1).max(12000).default(6000)
}).strict();
export type SessionReadWindowQuery = z.infer<typeof SessionReadWindowQuerySchema>;
export const SessionReadWindowSchema = z.object({
  items: z.array(SessionSearchHitSchema.extend({ content: z.string().max(3000), truncated: z.boolean() })).max(21),
  truncated: z.boolean()
}).strict();
export type SessionReadWindow = z.infer<typeof SessionReadWindowSchema>;
