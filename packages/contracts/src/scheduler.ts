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

export const ScheduleTargetSchema = z.discriminatedUnion('kind', [
  AgentScheduleTargetSchema,
  WorkflowScheduleTargetSchema,
  TeamMemberScheduleTargetSchema
]);
export type ScheduleTargetContract = z.infer<typeof ScheduleTargetSchema>;

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

export const ScheduleRunSchema = z.object({
  id: SchedulerIdSchema,
  scheduleId: SchedulerIdSchema,
  occurrenceKey: z.string().min(1).max(512),
  scheduledFor: TimestampSchema,
  trigger: z.enum(['timer', 'misfire', 'manual']),
  status: ScheduleRunStatusSchema,
  targetKind: z.enum(['agent', 'workflow', 'team_member']),
  targetExecutionId: z.string().min(1).max(512).optional(),
  claimedBy: SchedulerIdSchema.optional(),
  claimExpiresAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  errorCode: z.string().max(256).optional(),
  error: z.string().max(100_000).optional(),
  resultPreview: z.string().max(4_096).optional(),
  targetSnapshot: ScheduleTargetSchema,
  version: z.number().int().positive()
}).strict();
export type ScheduleRunContract = z.infer<typeof ScheduleRunSchema>;

export const CreateScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  enabled: z.boolean().optional(),
  spec: ScheduleSpecSchema,
  target: ScheduleTargetSchema,
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
