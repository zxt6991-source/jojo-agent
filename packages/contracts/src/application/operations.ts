import { z } from 'zod';
import {
  ApplicationSessionSnapshotSchema, ApplicationSessionSummarySchema,
  CreateSessionInputSchema, PatchSessionMetadataInputSchema, StartRunInputSchema,
  RunSnapshotSchema, TranscriptQuerySchema, TranscriptPageSchema,
  PendingApprovalSnapshotSchema, ResolveApprovalInputSchema
} from './index.js';
import {
  CreateChannelInstanceInputSchema, UpdateChannelInstanceInputSchema, ChannelInstanceSchema,
  CreateChannelBindingInputSchema, UpdateChannelBindingInputSchema, ChannelBindingSchema,
  ApproveChannelPairingInputSchema, TestChannelInputSchema, ChannelDeliveryReceiptSchema
} from './channels.js';
import {
  CreateScheduleInputSchema, UpdateScheduleInputSchema, SaveScheduleInputSchema,
  ScheduleSchema, ScheduleRunSchema, SetScheduleEnabledInputSchema
} from '../scheduler.js';

type Operation<Input extends z.ZodType, Output extends z.ZodType> = {
  kind: 'command' | 'query';
  input: Input;
  output: Output;
  permission: string;
  /** A retry is safe without an adapter-provided idempotency key. */
  idempotent: boolean;
};
function defineOperation<I extends z.ZodType, O extends z.ZodType>(operation: Operation<I, O>): Operation<I, O> {
  return operation;
}
const EmptyInputSchema = z.object({}).strict();

/** Resource IDs belong to adapter routing. Inputs describe the application body/query only. */
export const APPLICATION_OPERATIONS = {
  'session.list': defineOperation({ kind: 'query', input: EmptyInputSchema, output: z.array(ApplicationSessionSummarySchema), permission: 'sessions:read', idempotent: true }),
  'session.create': defineOperation({ kind: 'command', input: CreateSessionInputSchema, output: ApplicationSessionSnapshotSchema, permission: 'sessions:write', idempotent: false }),
  'session.patch': defineOperation({ kind: 'command', input: PatchSessionMetadataInputSchema, output: ApplicationSessionSnapshotSchema, permission: 'sessions:write', idempotent: false }),
  'session.get': defineOperation({ kind: 'query', input: EmptyInputSchema, output: ApplicationSessionSnapshotSchema, permission: 'sessions:read', idempotent: true }),
  'transcript.get': defineOperation({ kind: 'query', input: TranscriptQuerySchema, output: TranscriptPageSchema, permission: 'sessions:read', idempotent: true }),
  'run.start': defineOperation({ kind: 'command', input: StartRunInputSchema, output: RunSnapshotSchema, permission: 'runs:start', idempotent: false }),
  'run.get': defineOperation({ kind: 'query', input: EmptyInputSchema, output: RunSnapshotSchema, permission: 'sessions:read', idempotent: true }),
  'approval.list': defineOperation({ kind: 'query', input: EmptyInputSchema, output: z.array(PendingApprovalSnapshotSchema), permission: 'sessions:read', idempotent: true }),
  'approval.resolve': defineOperation({ kind: 'command', input: ResolveApprovalInputSchema, output: z.void(), permission: 'approvals:resolve', idempotent: true }),
  'schedule.create': defineOperation({ kind: 'command', input: CreateScheduleInputSchema, output: ScheduleSchema, permission: 'schedules:write', idempotent: false }),
  'schedule.update': defineOperation({ kind: 'command', input: UpdateScheduleInputSchema, output: ScheduleSchema, permission: 'schedules:write', idempotent: false }),
  'schedule.save': defineOperation({ kind: 'command', input: SaveScheduleInputSchema, output: ScheduleSchema, permission: 'schedules:write', idempotent: false }),
  'schedule.enabled': defineOperation({ kind: 'command', input: SetScheduleEnabledInputSchema, output: ScheduleSchema, permission: 'schedules:write', idempotent: false }),
  'schedule.run-now': defineOperation({ kind: 'command', input: z.object({ respectConcurrency: z.boolean().optional() }).strict(), output: ScheduleRunSchema, permission: 'schedules:run', idempotent: false }),
  'channel.instance.create': defineOperation({ kind: 'command', input: CreateChannelInstanceInputSchema, output: ChannelInstanceSchema, permission: 'channels:write', idempotent: false }),
  'channel.instance.update': defineOperation({ kind: 'command', input: UpdateChannelInstanceInputSchema, output: ChannelInstanceSchema, permission: 'channels:write', idempotent: false }),
  'channel.binding.create': defineOperation({ kind: 'command', input: CreateChannelBindingInputSchema, output: ChannelBindingSchema, permission: 'channels:bind', idempotent: false }),
  'channel.binding.update': defineOperation({ kind: 'command', input: UpdateChannelBindingInputSchema, output: ChannelBindingSchema, permission: 'channels:bind', idempotent: false }),
  'channel.pairing.approve': defineOperation({ kind: 'command', input: ApproveChannelPairingInputSchema, output: ChannelBindingSchema, permission: 'channels:approve', idempotent: false }),
  'channel.test': defineOperation({ kind: 'command', input: TestChannelInputSchema, output: ChannelDeliveryReceiptSchema, permission: 'channels:send', idempotent: false })
} as const;

export type ApplicationOperationId = keyof typeof APPLICATION_OPERATIONS;
export type OperationInput<Id extends ApplicationOperationId> = z.infer<typeof APPLICATION_OPERATIONS[Id]['input']>;
export type OperationOutput<Id extends ApplicationOperationId> = z.infer<typeof APPLICATION_OPERATIONS[Id]['output']>;
