import { z } from 'zod';
import {
  ApprovalRequestSchema,
  ExecutionScopeSchema,
  JsonValueSchema,
  MessageSchema,
  RunResultSchema,
  RuntimeEventEnvelopeSchema,
  RuntimeInputSchema,
  SessionSnapshotSchema
} from '@desktop-agent/contracts';

export const JOJO_SERVER_PROTOCOL_VERSION = 1 as const;

export const ProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: JsonValueSchema.optional(),
  requestId: z.string().min(1).optional()
}).strict();
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const ErrorResponseSchema = z.object({ error: ProtocolErrorSchema }).strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const PrincipalSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['local', 'token', 'service']),
  scopes: z.array(z.string().min(1))
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

export const RequestContextSchema = z.object({
  requestId: z.string().min(1),
  principal: PrincipalSchema,
  connectionId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional()
}).strict();
export type RequestContext = z.infer<typeof RequestContextSchema>;

export const ServerInfoSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  protocolVersion: z.literal(JOJO_SERVER_PROTOCOL_VERSION)
}).strict();
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const ServerCapabilitiesSchema = z.object({
  runtime: z.object({
    lanes: z.boolean(),
    resumeOperation: z.boolean(),
    transcriptQuery: z.boolean(),
    runQuery: z.boolean(),
    steer: z.boolean(),
    followUp: z.boolean(),
    durableSuspend: z.boolean()
  }).strict(),
  workflow: z.boolean(),
  browser: z.boolean(),
  memory: z.boolean(),
  subagents: z.boolean(),
  images: z.boolean(),
  approvals: z.boolean()
}).strict();
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).optional()
}).strict();
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

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

export const ServerSessionSummarySchema = z.object({
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
export type ServerSessionSummary = z.infer<typeof ServerSessionSummarySchema>;

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
  error: ProtocolErrorSchema.optional()
}).strict();
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;

export const ApprovalDecisionSchema = z.enum(['allow', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ResolveApprovalInputSchema = z.object({ decision: ApprovalDecisionSchema }).strict();
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInputSchema>;

export const PendingApprovalSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  laneId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  request: ApprovalRequestSchema
}).strict();
export type PendingApprovalSnapshot = z.infer<typeof PendingApprovalSnapshotSchema>;

export const LeaseModeSchema = z.enum(['observe', 'control']);
export type LeaseMode = z.infer<typeof LeaseModeSchema>;

export const LeaseSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  mode: LeaseModeSchema,
  clientId: z.string().min(1),
  connectionId: z.string().min(1),
  acquiredAt: z.string().datetime()
}).strict();
export type LeaseSnapshot = z.infer<typeof LeaseSnapshotSchema>;

export const AttachSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  mode: LeaseModeSchema.default('observe')
}).strict();
export type AttachSessionInput = z.infer<typeof AttachSessionInputSchema>;

export const ServerSessionSnapshotSchema = z.object({
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
  pendingApprovals: z.array(PendingApprovalSnapshotSchema),
  lease: LeaseSnapshotSchema.nullable()
}).strict();
export type ServerSessionSnapshot = z.infer<typeof ServerSessionSnapshotSchema>;

export const ServerSnapshotSchema = z.object({
  server: ServerInfoSchema,
  capabilities: ServerCapabilitiesSchema,
  sessions: z.array(ServerSessionSummarySchema)
}).strict();
export type ServerSnapshot = z.infer<typeof ServerSnapshotSchema>;

const ClientDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1)
}).strict();

export const ClientHelloSchema = z.object({
  type: z.literal('hello'),
  version: z.number().int().positive(),
  auth: z.object({ type: z.literal('bearer'), token: z.string().min(1) }).strict().optional(),
  client: ClientDescriptorSchema
}).strict();
export type ClientHello = z.infer<typeof ClientHelloSchema>;

const CommandBaseSchema = z.object({ id: z.string().min(1) });
export const ClientCommandSchema = z.discriminatedUnion('type', [
  CommandBaseSchema.extend({ type: z.literal('server.snapshot') }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.list') }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.create'), input: CreateSessionInputSchema }).strict(),
  CommandBaseSchema.extend({
    type: z.literal('session.patch'),
    sessionId: z.string().min(1),
    input: PatchSessionMetadataInputSchema
  }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.attach'), input: AttachSessionInputSchema }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.detach'), sessionId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.snapshot'), sessionId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.start'), sessionId: z.string().min(1), input: StartRunInputSchema }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.cancel'), sessionId: z.string().min(1), runId: z.string().min(1), reason: z.string().optional() }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.get'), sessionId: z.string().min(1), runId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('approval.resolve'), approvalId: z.string().min(1), input: ResolveApprovalInputSchema }).strict()
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const ServerHelloSchema = z.object({
  type: z.literal('hello'),
  version: z.literal(JOJO_SERVER_PROTOCOL_VERSION),
  connectionId: z.string().min(1),
  server: ServerInfoSchema
}).strict();

export const ServerWireMessageSchema = z.union([
  ServerHelloSchema,
  z.object({ type: z.literal('hello_error'), error: ProtocolErrorSchema }).strict(),
  z.object({ type: z.literal('response'), id: z.string().min(1), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ type: z.literal('response'), id: z.string().min(1), ok: z.literal(false), error: ProtocolErrorSchema }).strict(),
  z.object({
    type: z.literal('event'),
    seq: z.number().int().positive(),
    sessionSeq: z.number().int().positive().optional(),
    sessionId: z.string().min(1),
    event: RuntimeEventEnvelopeSchema
  }).strict(),
  z.object({ type: z.literal('session.snapshot'), snapshot: ServerSessionSnapshotSchema }).strict(),
  z.object({ type: z.literal('server.shutdown'), reason: z.string().optional() }).strict()
]);
export type ServerWireMessage = z.infer<typeof ServerWireMessageSchema>;

export function protocolError(code: string, message: string, options: {
  retryable?: boolean;
  details?: z.infer<typeof JsonValueSchema>;
  requestId?: string;
} = {}): ProtocolError {
  return { code, message, ...options };
}
