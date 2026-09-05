import { z } from 'zod';
import { ApprovalRequestSchema } from './agent.js';
import { ExecutionScopeSchema, JsonValueSchema } from './execution-scope.js';
import { FileContentBlockSchema, ImageContentBlockSchema, MessageSchema, TextContentBlockSchema } from './messages.js';
export { ExecutionScopeSchema, JsonValueSchema } from './execution-scope.js';
export type { ExecutionScope, JsonValue } from './execution-scope.js';

export const RUNTIME_CONTRACT_VERSION = 1 as const;

export const RuntimeInputBlockSchema = z.discriminatedUnion('type', [
  TextContentBlockSchema.strict(),
  ImageContentBlockSchema,
  FileContentBlockSchema
]);
export type RuntimeInputBlock = z.infer<typeof RuntimeInputBlockSchema>;

export const RuntimeInputSchema = z.object({
  content: z.array(RuntimeInputBlockSchema).min(1)
}).strict();
export type RuntimeInput = z.infer<typeof RuntimeInputSchema>;

export const SessionInfoSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  executionScope: ExecutionScopeSchema,
  metadata: z.record(z.string(), JsonValueSchema).optional()
}).strict();
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const LaneInfoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentLaneId: z.string().min(1).optional(),
  activeRunId: z.string().min(1).optional()
}).strict();
export type LaneInfo = z.infer<typeof LaneInfoSchema>;

export const RuntimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  detail: JsonValueSchema.optional()
}).strict();
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const RunResultSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  laneId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  stopReason: z.string().optional(),
  finalText: z.string().optional(),
  messages: z.array(MessageSchema),
  error: RuntimeErrorSchema.optional()
}).strict();
export type RunResult = z.infer<typeof RunResultSchema>;

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started') }).strict(),
  z.object({ type: z.literal('assistant.delta'), text: z.string() }).strict(),
  z.object({
    type: z.literal('tool.requested'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: JsonValueSchema
  }).strict(),
  z.object({ type: z.literal('approval.required'), request: ApprovalRequestSchema }).strict(),
  z.object({
    type: z.literal('tool.started'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: JsonValueSchema
  }).strict(),
  z.object({
    type: z.literal('tool.completed'),
    toolCallId: z.string().min(1),
    ok: z.boolean(),
    code: z.string().optional()
  }).strict(),
  z.object({
    type: z.literal('tool.progress'),
    toolCallId: z.string().min(1),
    text: z.string()
  }).strict(),
  z.object({
    type: z.literal('context.compacted'),
    compactedMessages: z.number().int().positive(),
    reclaimedToolCharacters: z.number().int().nonnegative()
  }).strict(),
  z.object({ type: z.literal('run.suspended'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('run.resumed') }).strict(),
  z.object({ type: z.literal('run.completed'), stopReason: z.string() }).strict(),
  z.object({ type: z.literal('run.failed'), error: RuntimeErrorSchema }).strict(),
  z.object({ type: z.literal('run.cancelled'), reason: z.string().optional() }).strict(),
  z.object({
    type: z.literal('usage.updated'),
    inputTokens: z.number().finite().nonnegative().optional(),
    outputTokens: z.number().finite().nonnegative().optional(),
    cacheReadInputTokens: z.number().finite().nonnegative().optional(),
    cacheWriteInputTokens: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional()
  }).strict()
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RuntimeEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  sessionId: z.string().min(1),
  laneId: z.string().min(1),
  runId: z.string().min(1).optional(),
  event: RuntimeEventSchema
}).strict();
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;

export const SessionSnapshotSchema = z.object({
  session: SessionInfoSchema,
  lanes: z.array(LaneInfoSchema)
}).strict();
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const LaneSnapshotSchema = z.object({
  lane: LaneInfoSchema,
  messageCount: z.number().int().nonnegative(),
  leafEntryId: z.string().min(1).optional()
}).strict();
export type LaneSnapshot = z.infer<typeof LaneSnapshotSchema>;
