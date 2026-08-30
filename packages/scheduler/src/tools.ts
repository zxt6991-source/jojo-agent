import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import type {
  Schedule,
  SchedulePrincipal,
  ScheduleRun,
  ScheduleSpec,
  ScheduleTarget
} from './types.js';
import type { ScheduleService } from './service.js';

const MAX_INTERVAL_MINUTES = 365 * 24 * 60;
const DEFAULT_MISFIRE_GRACE_MINUTES = 24 * 60;

const SpecInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(1).max(MAX_INTERVAL_MINUTES),
    anchorAt: z.string().datetime({ offset: true }).optional()
  }).strict(),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(1).max(256),
    timezone: z.string().trim().min(1).max(128).optional()
  }).strict()
]);

const TargetInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    prompt: z.string().trim().min(1).max(100_000)
  }).strict(),
  z.object({
    kind: z.literal('team_member'),
    teamId: z.string().min(1).max(256),
    memberId: z.string().min(1).max(256),
    task: z.string().trim().min(1).max(100_000)
  }).strict(),
  z.object({
    kind: z.literal('saved_workflow'),
    name: z.string().trim().min(1).max(256),
    args: z.record(z.string(), z.unknown()).optional()
  }).strict()
]);

const MisfireInput = z.object({
  kind: z.enum(['skip', 'fire_once']),
  graceMinutes: z.number().int().min(0).max(MAX_INTERVAL_MINUTES).optional()
}).strict();

const CreateInput = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  spec: SpecInput,
  target: TargetInput,
  enabled: z.boolean().optional(),
  misfire: MisfireInput.optional(),
  concurrency: z.enum(['skip', 'queue']).optional()
}).strict();

const UpdateInput = z.object({
  scheduleId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(256).optional(),
  description: z.string().max(4_000).optional(),
  spec: SpecInput.optional(),
  target: TargetInput.optional(),
  misfire: MisfireInput.optional(),
  concurrency: z.enum(['skip', 'queue']).optional()
}).strict();

const IdInput = z.object({ scheduleId: z.string().min(1).max(256) }).strict();
const EnabledInput = z.object({
  scheduleId: z.string().min(1).max(256),
  enabled: z.boolean()
}).strict();
const RunsInput = z.object({
  scheduleId: z.string().min(1).max(256),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();
const RunIdInput = z.object({ runId: z.string().min(1).max(256) }).strict();

type SpecInputValue = z.infer<typeof SpecInput>;
type TargetInputValue = z.infer<typeof TargetInput>;
type MisfireInputValue = z.infer<typeof MisfireInput>;

export type SchedulerToolOptions = {
  providerId: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  principal: SchedulePrincipal;
  defaultTimezone?: string;
  now?: () => Date;
};

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return {
    callId: '',
    ok,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...(code ? { code } : {})
  };
}

function schedulerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([a-z0-9_]+):/u)?.[1] ?? 'scheduler_failed';
}

function failure(error: unknown): ToolResult {
  return result(
    false,
    error instanceof Error ? error.message : String(error),
    schedulerErrorCode(error)
  );
}

function invalidInput(error: z.ZodError): ToolResult {
  return result(false, error.message, 'invalid_input');
}

function toScheduleSpec(input: SpecInputValue, now: Date, defaultTimezone: string): ScheduleSpec {
  if (input.kind === 'once') return { kind: 'once', runAt: input.runAt };
  if (input.kind === 'interval') {
    return {
      kind: 'interval',
      intervalMs: input.everyMinutes * 60_000,
      anchorAt: input.anchorAt ?? now.toISOString()
    };
  }
  return {
    kind: 'cron',
    expression: input.expression,
    timezone: input.timezone ?? defaultTimezone
  };
}

function toScheduleTarget(
  input: TargetInputValue,
  context: ToolContext,
  options: SchedulerToolOptions
): ScheduleTarget {
  if (input.kind === 'agent') {
    const budget = {
      ...(options.contextWindowTokens !== undefined
        ? { contextWindowTokens: options.contextWindowTokens }
        : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {})
    };
    return {
      kind: 'agent',
      sessionId: context.sessionId,
      providerId: options.providerId,
      model: options.model,
      input: { content: [{ type: 'text', text: input.prompt }] },
      lane: { mode: 'dedicated' },
      ...(Object.keys(budget).length > 0 ? { budget } : {})
    };
  }
  if (input.kind === 'team_member') {
    return {
      kind: 'team_member',
      teamId: input.teamId,
      memberId: input.memberId,
      task: input.task,
      parentSessionId: context.sessionId,
      providerId: options.providerId,
      model: options.model
    };
  }
  return {
    kind: 'workflow',
    sessionId: context.sessionId,
    workingDirectory: context.workingDirectory,
    providerId: options.providerId,
    model: options.model,
    workflow: {
      kind: 'saved',
      name: input.name,
      ...(input.args ? { args: input.args } : {})
    }
  };
}

function toMisfire(input: MisfireInputValue | undefined) {
  if (input?.kind === 'skip') return { kind: 'skip' as const };
  return {
    kind: 'fire_once' as const,
    graceMs: (input?.graceMinutes ?? DEFAULT_MISFIRE_GRACE_MINUTES) * 60_000
  };
}

function compactSchedule(schedule: Schedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    targetKind: schedule.target.kind,
    spec: schedule.spec,
    nextRunAt: schedule.nextRunAt ?? null,
    lastRunAt: schedule.lastRunAt ?? null,
    revision: schedule.revision
  };
}

function compactMutationSchedule(schedule: Schedule) {
  return { scheduleId: schedule.id, ...compactSchedule(schedule) };
}

function compactRun(run: ScheduleRun) {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    scheduledFor: run.scheduledFor,
    trigger: run.trigger,
    status: run.status,
    targetKind: run.targetKind,
    targetExecutionId: run.targetExecutionId ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    errorCode: run.errorCode ?? null,
    error: run.error ?? null,
    resultPreview: run.resultPreview ?? null,
    deliveryStatus: run.deliveryStatus ?? null,
    deliveryMessageId: run.deliveryMessageId ?? null,
    deliveryError: run.deliveryError ?? null
  };
}

const SPEC_SCHEMA = {
  oneOf: [
    {
      type: 'object', properties: { kind: { const: 'once' }, runAt: { type: 'string', format: 'date-time' } },
      required: ['kind', 'runAt'], additionalProperties: false
    },
    {
      type: 'object', properties: {
        kind: { const: 'interval' },
        everyMinutes: { type: 'integer', minimum: 1, maximum: MAX_INTERVAL_MINUTES },
        anchorAt: { type: 'string', format: 'date-time' }
      }, required: ['kind', 'everyMinutes'], additionalProperties: false
    },
    {
      type: 'object', properties: {
        kind: { const: 'cron' }, expression: { type: 'string' }, timezone: { type: 'string' }
      }, required: ['kind', 'expression'], additionalProperties: false
    }
  ]
};

const TARGET_SCHEMA = {
  oneOf: [
    {
      type: 'object', properties: { kind: { const: 'agent' }, prompt: { type: 'string' } },
      required: ['kind', 'prompt'], additionalProperties: false
    },
    {
      type: 'object', properties: {
        kind: { const: 'team_member' }, teamId: { type: 'string' }, memberId: { type: 'string' }, task: { type: 'string' }
      }, required: ['kind', 'teamId', 'memberId', 'task'], additionalProperties: false
    },
    {
      type: 'object', properties: {
        kind: { const: 'saved_workflow' }, name: { type: 'string' }, args: { type: 'object' }
      }, required: ['kind', 'name'], additionalProperties: false
    }
  ]
};

const MISFIRE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['skip', 'fire_once'] },
    graceMinutes: { type: 'integer', minimum: 0, maximum: MAX_INTERVAL_MINUTES }
  },
  required: ['kind'],
  additionalProperties: false
};

function mutationTool(tool: Omit<Tool, 'replay' | 'repeatPolicy' | 'risk' | 'effects'>): Tool {
  return {
    ...tool,
    replay: 'never',
    repeatPolicy: 'bounded',
    risk: 'write',
    effects: ['scheduler.write']
  };
}

export function createSchedulerTools(service: ScheduleService, options: SchedulerToolOptions): Tool[] {
  const now = options.now ?? (() => new Date());
  const timezone = options.defaultTimezone ?? 'UTC';

  return [
    {
      replay: 'safe',
      repeatPolicy: 'idempotent-observation',
      risk: 'read',
      effects: ['scheduler.read'],
      definition: {
        name: 'schedule_list',
        description: 'List durable automations visible to the current user. Returns compact summaries.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = z.object({}).strict().safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          return result(true, { schedules: (await service.list()).map(compactSchedule) });
        } catch (error) { return failure(error); }
      }
    },
    {
      replay: 'safe',
      repeatPolicy: 'idempotent-observation',
      risk: 'read',
      effects: ['scheduler.read'],
      definition: {
        name: 'schedule_get',
        description: 'Get the complete configuration of one durable automation by schedule id.',
        inputSchema: {
          type: 'object', properties: { scheduleId: { type: 'string' } },
          required: ['scheduleId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try { return result(true, { schedule: await service.get(parsed.data.scheduleId) }); }
        catch (error) { return failure(error); }
      }
    },
    mutationTool({
      definition: {
        name: 'schedule_create',
        description: 'Create a durable future or recurring automation. Use only when the user explicitly asks for a reminder, scheduled task, recurring task, automation, or future execution.',
        inputSchema: {
          type: 'object', properties: {
            name: { type: 'string' }, description: { type: 'string' }, spec: SPEC_SCHEMA,
            target: TARGET_SCHEMA, enabled: { type: 'boolean' }, misfire: MISFIRE_SCHEMA,
            concurrency: { type: 'string', enum: ['skip', 'queue'] }
          }, required: ['name', 'spec', 'target'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = CreateInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          const schedule = await service.create({
            name: parsed.data.name,
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
            enabled: parsed.data.enabled ?? true,
            spec: toScheduleSpec(parsed.data.spec, now(), timezone),
            target: toScheduleTarget(parsed.data.target, context, options),
            delivery: {
              conversation: { enabled: true, sessionId: context.sessionId }
            },
            misfire: toMisfire(parsed.data.misfire),
            concurrency: parsed.data.concurrency ?? 'skip'
          }, options.principal);
          return result(true, compactMutationSchedule(schedule));
        } catch (error) { return failure(error); }
      }
    }),
    mutationTool({
      definition: {
        name: 'schedule_update',
        description: 'Update the name, description, timing, target, misfire behavior, or concurrency of an existing automation.',
        inputSchema: {
          type: 'object', properties: {
            scheduleId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
            spec: SPEC_SCHEMA, target: TARGET_SCHEMA, misfire: MISFIRE_SCHEMA,
            concurrency: { type: 'string', enum: ['skip', 'queue'] }
          }, required: ['scheduleId'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = UpdateInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          const current = await service.get(parsed.data.scheduleId);
          const updated = await service.update(parsed.data.scheduleId, {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
            ...(parsed.data.spec !== undefined ? { spec: toScheduleSpec(parsed.data.spec, now(), timezone) } : {}),
            ...(parsed.data.target !== undefined ? { target: toScheduleTarget(parsed.data.target, context, options) } : {}),
            ...(parsed.data.misfire !== undefined ? { misfire: toMisfire(parsed.data.misfire) } : {}),
            ...(parsed.data.concurrency !== undefined ? { concurrency: parsed.data.concurrency } : {}),
            expectedRevision: current.revision
          });
          return result(true, compactMutationSchedule(updated));
        } catch (error) { return failure(error); }
      }
    }),
    mutationTool({
      definition: {
        name: 'schedule_set_enabled',
        description: 'Pause or resume an existing durable automation.',
        inputSchema: {
          type: 'object', properties: { scheduleId: { type: 'string' }, enabled: { type: 'boolean' } },
          required: ['scheduleId', 'enabled'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = EnabledInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          const current = await service.get(parsed.data.scheduleId);
          const updated = await service.setEnabled(parsed.data.scheduleId, parsed.data.enabled, current.revision);
          return result(true, compactMutationSchedule(updated));
        } catch (error) { return failure(error); }
      }
    }),
    mutationTool({
      definition: {
        name: 'schedule_delete',
        description: 'Delete an existing durable automation.',
        inputSchema: {
          type: 'object', properties: { scheduleId: { type: 'string' } },
          required: ['scheduleId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          await service.delete(parsed.data.scheduleId);
          return result(true, { scheduleId: parsed.data.scheduleId, deleted: true });
        } catch (error) { return failure(error); }
      }
    }),
    mutationTool({
      definition: {
        name: 'schedule_run_now',
        description: 'Immediately trigger one manual run of an existing durable automation.',
        inputSchema: {
          type: 'object', properties: { scheduleId: { type: 'string' } },
          required: ['scheduleId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try { return result(true, { run: compactRun(await service.runNow(parsed.data.scheduleId)) }); }
        catch (error) { return failure(error); }
      }
    }),
    {
      replay: 'safe',
      repeatPolicy: 'polling',
      risk: 'read',
      effects: ['scheduler.read'],
      definition: {
        name: 'schedule_runs',
        description: 'List recent runs and results for one durable automation. Defaults to 20 and returns at most 100.',
        inputSchema: {
          type: 'object', properties: {
            scheduleId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          }, required: ['scheduleId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = RunsInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          return result(true, {
            runs: (await service.listRuns(parsed.data.scheduleId, { limit: parsed.data.limit })).map(compactRun)
          });
        } catch (error) { return failure(error); }
      }
    },
    mutationTool({
      definition: {
        name: 'schedule_cancel_run',
        description: 'Cancel one active schedule run by run id.',
        inputSchema: {
          type: 'object', properties: { runId: { type: 'string' } },
          required: ['runId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = RunIdInput.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error);
        try {
          await service.cancelRun(parsed.data.runId);
          return result(true, { runId: parsed.data.runId, cancelled: true });
        } catch (error) { return failure(error); }
      }
    })
  ];
}
