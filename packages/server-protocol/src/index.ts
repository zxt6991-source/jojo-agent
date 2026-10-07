import { APPLICATION_OPERATIONS } from '@desktop-agent/contracts/application/operations';
import { BUILD_COMPATIBILITY } from '@desktop-agent/contracts/build-compatibility';
import {
  ApplicationErrorSchema,
  ApplicationContextSchema,
  ApplicationSessionSnapshotSchema,
  ApplicationSessionSummarySchema as ServerSessionSummarySchema,
  RunSnapshotSchema as ApplicationRunSnapshotSchema
} from '@desktop-agent/contracts/application';
export {
  CreateSessionInputSchema,
  PatchSessionMetadataInputSchema,
  TranscriptQuerySchema,
  TranscriptItemSchema,
  TranscriptPageSchema,
  RunStatusSchema,
  ApprovalDecisionSchema,
  ResolveApprovalInputSchema,
  PendingApprovalSnapshotSchema,
  PrincipalSchema
} from '@desktop-agent/contracts/application';
export type { CreateSessionInput, PatchSessionMetadataInput, TranscriptQuery, TranscriptItem, TranscriptPage, RunStatus, ApprovalDecision, ResolveApprovalInput, PendingApprovalSnapshot, Principal, ApplicationSessionSummary as ServerSessionSummary } from '@desktop-agent/contracts/application';
export { ServerSessionSummarySchema };
export { SessionSearchQuerySchema, SessionSearchHitSchema, SessionReadWindowQuerySchema, SessionReadWindowSchema } from '@desktop-agent/contracts';
export type { SessionSearchQuery, SessionSearchHit, SessionReadWindowQuery, SessionReadWindow } from '@desktop-agent/contracts';
import { FileAttachmentRefSchema } from '@desktop-agent/contracts';
import { z } from 'zod';
import {
  CreateScheduleInputSchema,
  JsonValueSchema,
  RuntimeEventEnvelopeSchema,
  ScheduleEventSchema,
  ScheduleRunSchema,
  ScheduleRunStatusSchema,
  ScheduleSchema,
  UpdateScheduleInputSchema
} from '@desktop-agent/contracts';

export const JOJO_SERVER_PROTOCOL_VERSION = BUILD_COMPATIBILITY.serverProtocol;

export const ProtocolErrorSchema = ApplicationErrorSchema.extend({
  requestId: z.string().min(1).optional()
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const ErrorResponseSchema = z.object({ error: ProtocolErrorSchema }).strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const RequestContextSchema = ApplicationContextSchema.extend({
  connectionId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional()
});
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

export {
  ChannelInstanceSchema,
  type ChannelInstanceDto,
  CreateChannelInstanceInputSchema,
  type CreateChannelInstanceInput,
  UpdateChannelInstanceInputSchema,
  type UpdateChannelInstanceInput,
  ChannelBindingSchema,
  type ChannelBindingDto,
  CreateChannelBindingInputSchema,
  type CreateChannelBindingInput,
  UpdateChannelBindingInputSchema,
  type UpdateChannelBindingInput,
  ChannelPairingSchema,
  type ChannelPairingDto,
  ChannelPairingListQuerySchema,
  ApproveChannelPairingInputSchema,
  type ApproveChannelPairingInput,
  ChannelDeliveryStatusSchema,
  ChannelDeliverySchema,
  type ChannelDeliveryDto,
  ChannelDeliveryReceiptSchema,
  type ChannelDeliveryReceiptDto,
  ChannelDeliveryListQuerySchema,
  type ChannelDeliveryListQuery,
  ChannelHealthSchema,
  type ChannelHealthDto,
  TestChannelInputSchema,
  type TestChannelInput
} from '@desktop-agent/contracts/application';

export const AttachmentUploadReceiptSchema = z.object({
  receipt: z.string().uuid(),
  attachment: FileAttachmentRefSchema,
  expiresAt: z.string().datetime(),
  previewWarning: z.string().optional()
}).strict();
export type AttachmentUploadReceipt = z.infer<typeof AttachmentUploadReceiptSchema>;

export const StartRunInputSchema = APPLICATION_OPERATIONS['run.start'].input.extend({
  attachmentReceipts: z.record(z.string().max(256), z.string().uuid()).optional()
});
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const RunSnapshotSchema = ApplicationRunSnapshotSchema.extend({
  error: ProtocolErrorSchema.optional()
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type { RunResult } from '@desktop-agent/contracts/application';

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

export const RunScheduleNowInputSchema = APPLICATION_OPERATIONS['schedule.run-now'].input;
export type RunScheduleNowInput = z.infer<typeof RunScheduleNowInputSchema>;

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

export const ServerSessionSnapshotSchema = ApplicationSessionSnapshotSchema.extend({
  activeRuns: z.array(RunSnapshotSchema),
  lease: LeaseSnapshotSchema.nullable()
});
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
  CommandBaseSchema.extend({ type: z.literal('session.search'), sessionId: z.string().min(1), input: APPLICATION_OPERATIONS['session.search'].input }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.read-window'), input: APPLICATION_OPERATIONS['session.read-window'].input }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.create'), input: APPLICATION_OPERATIONS['session.create'].input }).strict(),
  CommandBaseSchema.extend({
    type: z.literal('session.patch'),
    sessionId: z.string().min(1),
    input: APPLICATION_OPERATIONS['session.patch'].input
  }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.attach'), input: AttachSessionInputSchema }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.detach'), sessionId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('session.snapshot'), sessionId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.start'), sessionId: z.string().min(1), input: StartRunInputSchema }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.cancel'), sessionId: z.string().min(1), runId: z.string().min(1), reason: z.string().optional() }).strict(),
  CommandBaseSchema.extend({ type: z.literal('run.get'), sessionId: z.string().min(1), runId: z.string().min(1) }).strict(),
  CommandBaseSchema.extend({ type: z.literal('approval.resolve'), approvalId: z.string().min(1), input: APPLICATION_OPERATIONS['approval.resolve'].input }).strict()
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
