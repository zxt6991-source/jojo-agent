import { z } from 'zod';
import {
  ApprovalRequestSchema,
  CreateScheduleInputSchema,
  ExecutionScopeSchema,
  JsonValueSchema,
  MessageSchema,
  RunResultSchema,
  RuntimeEventEnvelopeSchema,
  RuntimeInputSchema,
  ScheduleEventSchema,
  ScheduleRunSchema,
  ScheduleRunStatusSchema,
  ScheduleSchema,
  SessionSnapshotSchema,
  UpdateScheduleInputSchema
} from '@desktop-agent/contracts';

export const JOJO_SERVER_PROTOCOL_VERSION = 3 as const;

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
  approvals: z.boolean(),
  scheduler: z.object({
    enabled: z.boolean(),
    targets: z.array(z.enum(['agent', 'workflow', 'team_member']))
  }).strict(),
  channels: z.object({
    enabled: z.boolean(),
    kinds: z.array(z.string().min(1)),
    inbound: z.boolean(),
    outbound: z.boolean(),
    approvals: z.boolean()
  }).strict()
}).strict();
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).optional()
}).strict();
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ChannelInstanceSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  enabled: z.boolean(),
  config: z.record(z.string(), JsonValueSchema),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)),
  revision: z.number().int().positive(),
  fingerprint: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ChannelInstanceDto = z.infer<typeof ChannelInstanceSchema>;

export const CreateChannelInstanceInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  kind: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), JsonValueSchema).default({}),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)).default({})
}).strict();
export type CreateChannelInstanceInput = z.infer<typeof CreateChannelInstanceInputSchema>;

export const UpdateChannelInstanceInputSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), JsonValueSchema).optional(),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)).optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type UpdateChannelInstanceInput = z.infer<typeof UpdateChannelInstanceInputSchema>;

const ChannelConversationSchema = z.object({
  id: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  type: z.enum(['direct', 'group'])
}).strict();

const ChannelRoutingSchema = z.object({
  sessionMode: z.enum(['persistent', 'per_thread', 'stateless']),
  sessionId: z.string().min(1).max(256).optional(),
  workspaceRoot: z.string().min(1).max(4_096).optional(),
  providerId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  instructions: z.array(z.string().max(20_000)).max(20).optional(),
  profile: z.string().min(1).max(256).optional()
}).strict();

const ChannelBindingPolicySchema = z.object({
  enabled: z.boolean(),
  requireMention: z.boolean(),
  queueMode: z.enum(['queue', 'reject', 'interrupt']),
  allowedSenders: z.array(z.string().min(1).max(512)).max(1_000).optional(),
  allowAttachments: z.boolean()
}).strict();

export const ChannelBindingSchema = z.object({
  id: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256),
  conversation: ChannelConversationSchema,
  routing: ChannelRoutingSchema,
  policy: ChannelBindingPolicySchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ChannelBindingDto = z.infer<typeof ChannelBindingSchema>;

export const CreateChannelBindingInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  instanceId: z.string().min(1).max(256),
  conversation: ChannelConversationSchema,
  routing: ChannelRoutingSchema,
  policy: ChannelBindingPolicySchema
}).strict();
export type CreateChannelBindingInput = z.infer<typeof CreateChannelBindingInputSchema>;

export const UpdateChannelBindingInputSchema = z.object({
  routing: ChannelRoutingSchema.optional(),
  policy: ChannelBindingPolicySchema.optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type UpdateChannelBindingInput = z.infer<typeof UpdateChannelBindingInputSchema>;

export const ChannelPairingSchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional()
}).strict();
export type ChannelPairingDto = z.infer<typeof ChannelPairingSchema>;

export const ChannelPairingListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional()
}).strict();

export const ApproveChannelPairingInputSchema = z.object({ binding: CreateChannelBindingInputSchema }).strict();
export type ApproveChannelPairingInput = z.infer<typeof ApproveChannelPairingInputSchema>;

export const ChannelDeliveryStatusSchema = z.enum(['pending', 'sending', 'delivered', 'failed', 'unknown']);
export const ChannelDeliverySchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  bindingId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  mode: z.enum(['reply', 'proactive', 'system']).optional(),
  status: ChannelDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
  nativeMessageId: z.string().optional(),
  lastError: z.string().optional()
}).strict();
export type ChannelDeliveryDto = z.infer<typeof ChannelDeliverySchema>;

export const ChannelDeliveryReceiptSchema = z.object({
  deliveryId: z.string().min(1),
  status: ChannelDeliveryStatusSchema,
  nativeMessageId: z.string().optional()
}).strict();
export type ChannelDeliveryReceiptDto = z.infer<typeof ChannelDeliveryReceiptSchema>;

export const ChannelDeliveryListQuerySchema = z.object({
  instanceId: z.string().min(1).optional(),
  status: ChannelDeliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
export type ChannelDeliveryListQuery = z.infer<typeof ChannelDeliveryListQuerySchema>;

export const ChannelHealthSchema = z.object({
  instanceId: z.string().min(1),
  status: z.enum(['starting', 'connected', 'degraded', 'stopped', 'failed']),
  lastInboundAt: z.string().datetime().optional(),
  lastOutboundAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  reconnectCount: z.number().int().nonnegative()
}).strict();
export type ChannelHealthDto = z.infer<typeof ChannelHealthSchema>;

export const TestChannelInputSchema = z.object({
  bindingId: z.string().min(1).max(256).optional(),
  conversationId: z.string().min(1).max(512).optional(),
  threadId: z.string().min(1).max(512).optional(),
  text: z.string().min(1).max(100_000).default('Jojo 通道连接测试成功。')
}).strict().refine((value) => Boolean(value.bindingId) !== Boolean(value.conversationId), {
  message: 'Exactly one of bindingId or conversationId is required.'
});
export type TestChannelInput = z.infer<typeof TestChannelInputSchema>;

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

export {
  CreateScheduleInputSchema,
  ScheduleEventSchema,
  ScheduleRunSchema,
  ScheduleSchema,
  UpdateScheduleInputSchema
};
export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;

export const ScheduleRunListQuerySchema = z.object({
  states: z.preprocess(
    (value) => typeof value === 'string' ? value.split(',').filter(Boolean) : value,
    z.array(ScheduleRunStatusSchema).max(9).optional()
  ),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
export type ScheduleRunListQuery = z.infer<typeof ScheduleRunListQuerySchema>;

export const RunScheduleNowInputSchema = z.object({
  respectConcurrency: z.boolean().optional()
}).strict();
export type RunScheduleNowInput = z.infer<typeof RunScheduleNowInputSchema>;

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
  z.object({ type: z.literal('schedule.event'), event: ScheduleEventSchema }).strict(),
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
