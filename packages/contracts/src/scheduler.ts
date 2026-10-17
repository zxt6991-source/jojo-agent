import { z } from 'zod';
import { RuntimeInputSchema } from './runtime.js';

const SchedulerIdSchema = z.string().min(1).max(256);
const TimestampSchema = z.string().datetime();

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), runAt: TimestampSchema }).strict(),
  z.object({
    kind: z.literal('interval'), intervalMs: z.number().int().min(60_000), anchorAt: TimestampSchema
  }).strict(),
  z.object({
    kind: z.literal('cron'), expression: z.string().trim().min(1).max(256),
    timezone: z.string().trim().min(1).max(128)
  }).strict()
]);
export type ScheduleSpecContract = z.infer<typeof ScheduleSpecSchema>;

export const AgentScheduleTargetSchema = z.object({
  kind: z.literal('agent'),
  sessionId: SchedulerIdSchema,
  input: RuntimeInputSchema,
  providerId: SchedulerIdSchema,
  model: z.string().min(1).max(512),
  instructions: z.array(z.string().max(100_000)).max(64).optional(),
  budget: z.object({
    maxIterations: z.number().int().positive().max(1_000).optional(),
    allowPartialOnLimit: z.boolean().optional(),
    contextWindowTokens: z.number().int().positive().max(2_000_000).optional(),
    maxOutputTokens: z.number().int().positive().max(128_000).optional()
  }).strict().optional(),
  lane: z.object({
    mode: z.enum(['dedicated', 'main']), id: SchedulerIdSchema.optional()
  }).strict().optional()
}).strict();
export type AgentScheduleTargetContract = z.infer<typeof AgentScheduleTargetSchema>;

export const WorkflowScheduleTargetSchema = z.object({
  kind: z.literal('workflow'),
  sessionId: SchedulerIdSchema,
  workingDirectory: z.string().min(1).max(4_096),
  providerId: SchedulerIdSchema,
  model: z.string().min(1).max(512),
  workflow: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('saved'), name: z.string().min(1).max(256),
      args: z.record(z.string(), z.unknown()).optional()
    }).strict(),
    z.object({
      kind: z.literal('inline'), definition: z.unknown(),
      args: z.record(z.string(), z.unknown()).optional()
    }).strict()
  ])
}).strict();
export type WorkflowScheduleTargetContract = z.infer<typeof WorkflowScheduleTargetSchema>;

export const TeamMemberScheduleTargetSchema = z.object({
  kind: z.literal('team_member'),
  teamId: SchedulerIdSchema,
  memberId: SchedulerIdSchema,
  task: z.string().trim().min(1).max(100_000),
  parentSessionId: SchedulerIdSchema,
  providerId: SchedulerIdSchema.optional(),
  model: z.string().min(1).max(512).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  maxIterations: z.number().int().positive().max(1_000).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
}).strict();
export type TeamMemberScheduleTargetContract = z.infer<typeof TeamMemberScheduleTargetSchema>;

export const ReminderScheduleTargetSchema = z.object({
  kind: z.literal('reminder'), text: z.string().trim().min(1).max(200)
}).strict();
export type ReminderScheduleTargetContract = z.infer<typeof ReminderScheduleTargetSchema>;

export const ScheduleTargetSchema = z.discriminatedUnion('kind', [
  AgentScheduleTargetSchema,
  WorkflowScheduleTargetSchema,
  TeamMemberScheduleTargetSchema,
  ReminderScheduleTargetSchema
]);
export type ScheduleTargetContract = z.infer<typeof ScheduleTargetSchema>;

export const ScheduleVoiceDeliverySchema = z.object({
  enabled: z.boolean(),
  deviceId: z.literal('local-desktop'),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fixed'), text: z.string().trim().min(1).max(200) }).strict(),
    z.object({ kind: z.literal('result'), maxChars: z.number().int().min(1).max(600) }).strict()
  ]),
  expiresAfterMs: z.number().int().min(1_000).max(7 * 86_400_000),
  presetId: SchedulerIdSchema.optional()
}).strict();
export type ScheduleVoiceDeliveryContract = z.infer<typeof ScheduleVoiceDeliverySchema>;

export const ScheduleDeliverySchema = z.object({
  voice: ScheduleVoiceDeliverySchema.optional(),
  conversation: z.object({
    enabled: z.boolean(),
    sessionId: SchedulerIdSchema
  }).strict().optional(),
  notification: z.object({ enabled: z.boolean() }).strict().optional(),
  channels: z.array(z.object({
    enabled: z.boolean(),
    bindingId: SchedulerIdSchema,
    mode: z.enum(['full', 'preview']).optional()
  }).strict()).max(20).optional()
}).strict();
export type ScheduleDeliveryContract = z.infer<typeof ScheduleDeliverySchema>;

export const MisfirePolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skip') }).strict(),
  z.object({ kind: z.literal('fire_once'), graceMs: z.number().int().nonnegative().max(365 * 86_400_000) }).strict()
]);
export type MisfirePolicyContract = z.infer<typeof MisfirePolicySchema>;

export const ScheduleConcurrencyPolicySchema = z.enum(['skip', 'queue', 'allow']);
export type ScheduleConcurrencyPolicyContract = z.infer<typeof ScheduleConcurrencyPolicySchema>;

export const ScheduleSchema = z.object({
  id: SchedulerIdSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(4_000).optional(),
  enabled: z.boolean(),
  spec: ScheduleSpecSchema,
  target: ScheduleTargetSchema,
  delivery: ScheduleDeliverySchema.optional(),
  misfire: MisfirePolicySchema,
  concurrency: ScheduleConcurrencyPolicySchema,
  nextRunAt: TimestampSchema.optional(),
  lastRunAt: TimestampSchema.optional(),
  revision: z.number().int().positive(),
  createdBy: SchedulerIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.optional()
}).strict();
export type ScheduleContract = z.infer<typeof ScheduleSchema>;

export const ScheduleRunStatusSchema = z.enum([
  'pending', 'dispatching', 'running', 'waiting_approval', 'completed', 'failed',
  'cancelled', 'skipped', 'interrupted'
]);

export const ScheduleDeliverySnapshotSchema = z.object({
  name: z.string().min(1).max(256),
  scheduleRevision: z.number().int().positive(),
  delivery: ScheduleDeliverySchema.optional()
}).strict();

const DeliveryPayloadBase = {
  title: z.string().min(1).max(256),
  createdAt: TimestampSchema,
  messageId: SchedulerIdSchema
};
export const ScheduleDeliveryPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ ...DeliveryPayloadBase, kind: z.literal('conversation'), content: z.string().min(1).max(100_000) }).strict(),
  z.object({ ...DeliveryPayloadBase, kind: z.literal('notification'), content: z.string().min(1).max(4_096) }).strict(),
  z.object({
    ...DeliveryPayloadBase, kind: z.literal('voice'), content: z.string().trim().min(1).max(600),
    deviceId: z.literal('local-desktop'), presetId: SchedulerIdSchema.optional(),
    presetVersion: SchedulerIdSchema.optional()
  }).strict(),
  z.object({
    ...DeliveryPayloadBase, kind: z.literal('channel'), content: z.string().min(1).max(100_000),
    mode: z.enum(['full', 'preview']).optional()
  }).strict()
]);
export const ScheduleDeliveryStateSchema = z.enum([
  'pending', 'preparing', 'ready', 'claimed', 'playing', 'played', 'delivered', 'failed',
  'suppressed', 'expired', 'uncertain', 'interrupted', 'cancelled'
]);
export const ScheduleDeliveryItemSchema = z.object({
  id: SchedulerIdSchema,
  scheduleRunId: SchedulerIdSchema,
  destination: z.enum(['conversation', 'notification', 'voice', 'channel']),
  destinationId: SchedulerIdSchema,
  dedupeKey: z.string().min(1).max(1_024),
  payloadSnapshot: ScheduleDeliveryPayloadSchema,
  state: ScheduleDeliveryStateSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  nextAttemptAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  claimToken: SchedulerIdSchema.optional(),
  claimExpiresAt: TimestampSchema.optional(),
  playbackId: SchedulerIdSchema.optional(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  errorCode: z.string().max(256).optional(),
  error: z.string().max(4_096).optional(),
  version: z.number().int().positive()
}).strict().superRefine((item, ctx) => {
  if (item.destination !== item.payloadSnapshot.kind) {
    ctx.addIssue({ code: 'custom', path: ['payloadSnapshot', 'kind'], message: 'Delivery destination does not match its payload.' });
  }
  if (item.destination === 'voice' && item.destinationId !== 'local-desktop') {
    ctx.addIssue({ code: 'custom', path: ['destinationId'], message: 'Only the local desktop is available for voice delivery.' });
  }
  if (item.createdAt !== item.payloadSnapshot.createdAt) {
    ctx.addIssue({ code: 'custom', path: ['payloadSnapshot', 'createdAt'], message: 'Delivery timestamp must remain fixed.' });
  }
  const identity = [item.claimToken, item.claimExpiresAt, item.playbackId, item.generation];
  if (identity.some((value) => value !== undefined) && identity.some((value) => value === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['claimToken'], message: 'A claim requires its complete playback identity and lease.' });
  }
  if (['claimed', 'playing'].includes(item.state) && !item.claimToken) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'Active delivery requires a claim.' });
  }
  if (item.claimToken && !['claimed', 'preparing', 'ready', 'playing'].includes(item.state)) {
    ctx.addIssue({ code: 'custom', path: ['claimToken'], message: 'Terminal delivery cannot retain a claim.' });
  }
});
export type ScheduleDeliveryItemContract = z.infer<typeof ScheduleDeliveryItemSchema>;

/** Hosts return only committed, user-visible execution text. */
export interface ResultContentPort {
  readCommittedResult(input: {
    targetKind: Exclude<ScheduleTargetContract['kind'], 'reminder'>;
    executionId: string;
  }): Promise<string | undefined>;
}

export const ScheduleRunSchema = z.object({
  id: SchedulerIdSchema,
  scheduleId: SchedulerIdSchema,
  occurrenceKey: z.string().min(1).max(512),
  scheduledFor: TimestampSchema,
  trigger: z.enum(['timer', 'misfire', 'manual']),
  status: ScheduleRunStatusSchema,
  targetKind: z.enum(['agent', 'workflow', 'team_member', 'reminder']),
  targetExecutionId: z.string().min(1).max(512).optional(),
  claimedBy: SchedulerIdSchema.optional(),
  claimExpiresAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  errorCode: z.string().max(256).optional(),
  error: z.string().max(100_000).optional(),
  resultPreview: z.string().max(4_096).optional(),
  deliveryStatus: z.enum(['pending', 'delivered', 'failed', 'skipped']).optional(),
  deliveryMessageId: SchedulerIdSchema.optional(),
  deliveryError: z.string().max(100_000).optional(),
  targetSnapshot: ScheduleTargetSchema,
  deliverySnapshot: ScheduleDeliverySnapshotSchema.optional(),
  deliveryItems: z.array(ScheduleDeliveryItemSchema).max(24).optional(),
  version: z.number().int().positive()
}).strict().superRefine((run, ctx) => {
  if (run.targetKind !== run.targetSnapshot.kind) {
    ctx.addIssue({ code: 'custom', path: ['targetKind'], message: 'Target kind must match the run snapshot.' });
  }
  if (run.deliveryItems?.some((item) => item.scheduleRunId !== run.id)) {
    ctx.addIssue({ code: 'custom', path: ['deliveryItems'], message: 'Delivery belongs to a different run.' });
  }
});
export type ScheduleRunContract = z.infer<typeof ScheduleRunSchema>;

export const CreateScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  enabled: z.boolean().optional(),
  spec: ScheduleSpecSchema,
  target: ScheduleTargetSchema,
  delivery: ScheduleDeliverySchema.optional(),
  misfire: MisfirePolicySchema.optional(),
  concurrency: ScheduleConcurrencyPolicySchema.optional()
}).strict();
export type CreateScheduleInputContract = z.infer<typeof CreateScheduleInputSchema>;

export const UpdateScheduleInputSchema = CreateScheduleInputSchema.partial().extend({
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type UpdateScheduleInputContract = z.infer<typeof UpdateScheduleInputSchema>;

export const SaveScheduleInputSchema = CreateScheduleInputSchema.extend({
  scheduleId: SchedulerIdSchema.optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type SaveScheduleInputContract = z.infer<typeof SaveScheduleInputSchema>;

export const ScheduleIdInputSchema = z.object({ scheduleId: SchedulerIdSchema }).strict();
export const ScheduleRunIdInputSchema = z.object({ runId: SchedulerIdSchema }).strict();
export const SetScheduleEnabledInputSchema = z.object({
  scheduleId: SchedulerIdSchema,
  enabled: z.boolean(),
  expectedRevision: z.number().int().positive().optional()
}).strict();

export const ScheduleEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('schedule.changed'), schedule: ScheduleSchema }).strict(),
  z.object({ type: z.literal('schedule.deleted'), scheduleId: SchedulerIdSchema }).strict(),
  z.object({ type: z.literal('schedule.run.changed'), run: ScheduleRunSchema }).strict()
]);
export type ScheduleEventContract = z.infer<typeof ScheduleEventSchema>;
