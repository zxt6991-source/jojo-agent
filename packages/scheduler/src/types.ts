import type { RuntimeInput } from '@desktop-agent/contracts/runtime';

export type ScheduleSpec =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; intervalMs: number; anchorAt: string }
  | { kind: 'cron'; expression: string; timezone: string };

export type AgentScheduleTarget = {
  kind: 'agent';
  sessionId: string;
  input: RuntimeInput;
  providerId: string;
  model: string;
  instructions?: string[];
  budget?: {
    maxIterations?: number;
    allowPartialOnLimit?: boolean;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  };
  lane?: { mode: 'dedicated' | 'main'; id?: string };
};

export type WorkflowScheduleTarget = {
  kind: 'workflow';
  sessionId: string;
  workingDirectory: string;
  providerId: string;
  model: string;
  workflow:
    | { kind: 'saved'; name: string; args?: Record<string, unknown> }
    | { kind: 'inline'; definition: unknown; args?: Record<string, unknown> };
};

export type TeamMemberScheduleTarget = {
  kind: 'team_member';
  teamId: string;
  memberId: string;
  task: string;
  parentSessionId: string;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  maxIterations?: number;
  outputSchema?: Record<string, unknown>;
};

export type ScheduleTarget = AgentScheduleTarget | WorkflowScheduleTarget | TeamMemberScheduleTarget;

export type ScheduleChannelDelivery = {
  enabled: boolean;
  bindingId: string;
  mode?: 'full' | 'preview';
};

export type ScheduleDelivery = {
  conversation?: { enabled: boolean; sessionId: string };
  notification?: { enabled: boolean };
  channels?: ScheduleChannelDelivery[];
};

export type MisfirePolicy = { kind: 'skip' } | { kind: 'fire_once'; graceMs: number };
export type ScheduleConcurrencyPolicy = 'skip' | 'queue' | 'allow';

export type Schedule = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  spec: ScheduleSpec;
  target: ScheduleTarget;
  delivery?: ScheduleDelivery;
  misfire: MisfirePolicy;
  concurrency: ScheduleConcurrencyPolicy;
  nextRunAt?: string;
  lastRunAt?: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ScheduleRunStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted';

export type ScheduleRunTrigger = 'timer' | 'misfire' | 'manual';

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  occurrenceKey: string;
  scheduledFor: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  targetKind: ScheduleTarget['kind'];
  targetExecutionId?: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  error?: string;
  resultPreview?: string;
  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'skipped';
  deliveryMessageId?: string;
  deliveryError?: string;
  targetSnapshot: ScheduleTarget;
  version: number;
};

export type CreateScheduleInput = {
  name: string;
  description?: string;
  enabled?: boolean;
  spec: ScheduleSpec;
  target: ScheduleTarget;
  delivery?: ScheduleDelivery;
  misfire?: MisfirePolicy;
  concurrency?: ScheduleConcurrencyPolicy;
};

export type UpdateScheduleInput = Partial<Omit<CreateScheduleInput, 'enabled'>> & {
  enabled?: boolean;
  expectedRevision?: number;
};

export type SchedulePrincipal = { id: string; type?: 'user' | 'service' };

export type ScheduleRunListOptions = {
  states?: ScheduleRunStatus[];
  limit?: number;
};

export type ScheduleEvent =
  | { type: 'schedule.changed'; schedule: Schedule }
  | { type: 'schedule.deleted'; scheduleId: string }
  | { type: 'schedule.run.changed'; run: ScheduleRun };

export const ACTIVE_SCHEDULE_RUN_STATUSES: readonly ScheduleRunStatus[] = [
  'pending', 'dispatching', 'running', 'waiting_approval'
];

export const TERMINAL_SCHEDULE_RUN_STATUSES: readonly ScheduleRunStatus[] = [
  'completed', 'failed', 'cancelled', 'skipped', 'interrupted'
];
