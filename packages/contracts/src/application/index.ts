export * from '../session-history.js';
// Host-independent application inputs and snapshots. Transport envelopes live in adapters.
import { z } from 'zod';
import { ApprovalRequestSchema } from '../agent.js';
import { ExecutionScopeSchema, JsonValueSchema } from '../execution-scope.js';
import { MessageSchema } from '../messages.js';
import { RunResultSchema, RuntimeInputSchema, SessionSnapshotSchema } from '../runtime.js';

export const ApplicationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: JsonValueSchema.optional()
}).strict();
export type ApplicationError = z.infer<typeof ApplicationErrorSchema>;

export const PrincipalSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['local', 'token', 'service']),
  scopes: z.array(z.string().min(1))
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

export const ApplicationContextSchema = z.object({
  requestId: z.string().min(1),
  principal: PrincipalSchema
}).strict();
export type ApplicationContext = z.infer<typeof ApplicationContextSchema>;

export const CreateSessionInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  labels: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  executionScope: ExecutionScopeSchema.default({ kind: 'none' })
}).strict();
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const PatchSessionMetadataInputSchema = z.object({
  title: z.string().trim().min(1).max(500).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  favorite: z.boolean().optional(),
  defaultProviderId: z.string().min(1).nullable().optional(),
  defaultModel: z.string().min(1).nullable().optional(),
  expectedRevision: z.number().int().nonnegative().optional()
}).strict();
export type PatchSessionMetadataInput = z.infer<typeof PatchSessionMetadataInputSchema>;

export const ApplicationSessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  labels: z.array(z.string()),
  favorite: z.boolean().default(false),
  defaultProviderId: z.string().optional(),
  defaultModel: z.string().optional(),
  createdAt: z.string().datetime(),
  executionScope: ExecutionScopeSchema,
  revision: z.number().int().nonnegative()
}).strict();
export type ApplicationSessionSummary = z.infer<typeof ApplicationSessionSummarySchema>;

export const TranscriptQuerySchema = z.object({
  laneId: z.string().min(1).default('main'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;

export const TranscriptItemSchema = z.object({
  id: z.string().min(1),
  laneId: z.string().min(1),
  sequence: z.number().int().positive(),
  message: MessageSchema
}).strict();
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const TranscriptPageSchema = z.object({
  items: z.array(TranscriptItemSchema),
  nextCursor: z.string().optional()
}).strict();
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;

export const RunStatusSchema = z.enum([
  'accepted', 'starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StartRunInputSchema = z.object({
  laneId: z.string().min(1).default('main'),
  input: RuntimeInputSchema,
  providerId: z.string().min(1),
  model: z.string().min(1),
  instructions: z.array(z.string()).optional(),
  budget: z.object({
    maxIterations: z.number().int().positive().optional(),
    allowPartialOnLimit: z.boolean().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional()
  }).strict().optional()
}).strict();
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const RunSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  laneId: z.string().min(1),
  status: RunStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  version: z.number().int().positive().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  result: RunResultSchema.optional(),
  error: ApplicationErrorSchema.optional()
}).strict();
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;

export const ApprovalDecisionSchema = z.enum(['allow', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ResolveApprovalInputSchema = z.object({ decision: ApprovalDecisionSchema }).strict();
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInputSchema>;

export const RunApprovalSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  laneId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  request: ApprovalRequestSchema
}).strict();
/** Session preparation may require approval before a Runtime run exists. */
export const SessionApprovalSnapshotSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1),
  scope: z.literal('session'),
  createdAt: z.string().datetime(), request: ApprovalRequestSchema
}).strict();
export const PendingApprovalSnapshotSchema = z.union([RunApprovalSnapshotSchema, SessionApprovalSnapshotSchema]);
export type PendingApprovalSnapshot = z.infer<typeof PendingApprovalSnapshotSchema>;

export const ApplicationSessionSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  labels: z.array(z.string()),
  favorite: z.boolean().default(false),
  defaultProviderId: z.string().optional(),
  defaultModel: z.string().optional(),
  executionScope: ExecutionScopeSchema,
  revision: z.number().int().nonnegative(),
  runtime: SessionSnapshotSchema,
  activeRuns: z.array(RunSnapshotSchema),
  transcript: z.array(TranscriptItemSchema),
  pendingApprovals: z.array(PendingApprovalSnapshotSchema)
}).strict();
export type ApplicationSessionSnapshot = z.infer<typeof ApplicationSessionSnapshotSchema>;

export * from './channels.js';

export { SessionMetadataOperationSchema, SessionMetadataResultSchema } from './session-metadata.js';
export type { SessionMetadataOperation, SessionMetadataResult } from './session-metadata.js';
