import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext } from '@desktop-agent/contracts';
import {
  createSchedulerTools,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleEvent,
  type SchedulePrincipal,
  type ScheduleRun,
  type ScheduleRunListOptions,
  type ScheduleService,
  type UpdateScheduleInput
} from '../src/index.js';

const context: ToolContext = {
  sessionId: 'session-1',
  workingDirectory: '/workspace',
  signal: new AbortController().signal,
  approved: true,
  onProgress: () => undefined
};

function agentTarget() {
  return {
    kind: 'agent' as const,
    sessionId: 'session-1',
    input: { content: [{ type: 'text' as const, text: 'original' }] },
    providerId: 'provider',
    model: 'model'
  };
}

class RecordingScheduleService implements ScheduleService {
  current: Schedule = {
    id: 'sch_1',
    name: 'existing',
    enabled: true,
    spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'UTC' },
    target: agentTarget(),
    misfire: { kind: 'fire_once', graceMs: 86_400_000 },
    concurrency: 'skip',
    nextRunAt: '2026-08-31T08:00:00.000Z',
    revision: 4,
    createdBy: 'user',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z'
  };
  createdInput?: CreateScheduleInput;
  principal?: SchedulePrincipal;
  updatedInput?: UpdateScheduleInput;
  listedRunsOptions: ScheduleRunListOptions | undefined;
  cancelledRunId?: string;

  async initialize(): Promise<void> {}
  async list(): Promise<Schedule[]> { return [this.current]; }
  async get(id: string): Promise<Schedule> {
    if (id !== this.current.id) throw new Error(`schedule_not_found: ${id}`);
    return this.current;
  }
  async create(input: CreateScheduleInput, principal: SchedulePrincipal): Promise<Schedule> {
    this.createdInput = input;
    this.principal = principal;
    this.current = { ...this.current, ...input, name: input.name, revision: 1, createdBy: principal.id };
    return this.current;
  }
  async update(id: string, input: UpdateScheduleInput): Promise<Schedule> {
    if (input.expectedRevision !== this.current.revision) {
      throw new Error(`schedule_revision_conflict: ${id}`);
    }
    this.updatedInput = input;
    this.current = { ...this.current, ...input, revision: this.current.revision + 1 };
    return this.current;
  }
  async setEnabled(id: string, enabled: boolean, expectedRevision?: number): Promise<Schedule> {
    return this.update(id, { enabled, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
  }
  async delete(id: string): Promise<void> { await this.get(id); }
  async runNow(id: string): Promise<ScheduleRun> {
    await this.get(id);
    return this.run();
  }
  async listRuns(id: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]> {
    await this.get(id);
    this.listedRunsOptions = options;
    return [this.run()];
  }
  async getRun(runId: string): Promise<ScheduleRun> {
    if (runId !== 'run_1') throw new Error(`schedule_run_not_found: ${runId}`);
    return this.run();
  }
  async cancelRun(runId: string): Promise<void> { this.cancelledRunId = runId; }
  subscribe(_listener: (event: ScheduleEvent) => void): () => void { return () => undefined; }
  async close(): Promise<void> {}

  private run(): ScheduleRun {
    return {
      id: 'run_1',
      scheduleId: this.current.id,
      occurrenceKey: 'manual:run_1',
      scheduledFor: '2026-08-30T00:00:00.000Z',
      trigger: 'manual',
      status: 'running',
      targetKind: this.current.target.kind,
      createdAt: '2026-08-30T00:00:00.000Z',
      targetSnapshot: this.current.target,
      version: 1
    };
  }
}

function schedulerTools(service: ScheduleService): Tool[] {
  return createSchedulerTools(service, {
    providerId: 'provider-1',
    model: 'model-1',
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    principal: { id: 'desktop-user', type: 'user' },
    defaultTimezone: 'Asia/Shanghai',
    now: () => new Date('2026-08-30T00:00:00.000Z')
  });
}

function tool(tools: Tool[], name: string): Tool {
  const match = tools.find((candidate) => candidate.definition.name === name);
  if (!match) throw new Error(`Missing tool ${name}`);
  return match;
}

function content(result: Awaited<ReturnType<Tool['execute']>>): any {
  return JSON.parse(result.content);
}

describe('conversation scheduler tools', () => {
  it('converts an agent cron target using current turn context and defaults', async () => {
    const service = new RecordingScheduleService();
    const result = await tool(schedulerTools(service), 'schedule_create').execute({
      name: 'daily',
      spec: { kind: 'cron', expression: '0 8 * * *' },
      target: { kind: 'agent', prompt: 'daily summary' }
    }, context);

    expect(result.ok).toBe(true);
    expect(content(result)).toMatchObject({ scheduleId: 'sch_1', targetKind: 'agent' });
    expect(service.principal).toEqual({ id: 'desktop-user', type: 'user' });
    expect(service.createdInput).toMatchObject({
      spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
      target: {
        kind: 'agent', sessionId: 'session-1', providerId: 'provider-1', model: 'model-1',
        input: { content: [{ type: 'text', text: 'daily summary' }] },
        lane: { mode: 'dedicated' },
        budget: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 }
      },
      delivery: { conversation: { enabled: true, sessionId: 'session-1' } },
      misfire: { kind: 'fire_once', graceMs: 86_400_000 },
      concurrency: 'skip'
    });
  });

  it('converts interval, saved workflow, and team member inputs', async () => {
    const intervalService = new RecordingScheduleService();
    await tool(schedulerTools(intervalService), 'schedule_create').execute({
      name: 'interval', spec: { kind: 'interval', everyMinutes: 5 },
      target: { kind: 'saved_workflow', name: 'review', args: { branch: 'main' } }
    }, context);
    expect(intervalService.createdInput).toMatchObject({
      spec: { kind: 'interval', intervalMs: 300_000, anchorAt: '2026-08-30T00:00:00.000Z' },
      target: {
        kind: 'workflow', sessionId: 'session-1', workingDirectory: '/workspace',
        providerId: 'provider-1', model: 'model-1',
        workflow: { kind: 'saved', name: 'review', args: { branch: 'main' } }
      }
    });

    const teamService = new RecordingScheduleService();
    await tool(schedulerTools(teamService), 'schedule_create').execute({
      name: 'team', spec: { kind: 'once', runAt: '2026-08-31T01:00:00+08:00' },
      target: { kind: 'team_member', teamId: 'team-1', memberId: 'reviewer', task: 'Review it' }
    }, context);
    expect(teamService.createdInput?.target).toEqual({
      kind: 'team_member', teamId: 'team-1', memberId: 'reviewer', task: 'Review it',
      parentSessionId: 'session-1', providerId: 'provider-1', model: 'model-1'
    });
  });

  it('fetches the latest revision before updating and preserves revision conflicts', async () => {
    const service = new RecordingScheduleService();
    const updateTool = tool(schedulerTools(service), 'schedule_update');
    const updated = await updateTool.execute({ scheduleId: 'sch_1', name: 'renamed' }, context);
    expect(updated.ok).toBe(true);
    expect(service.updatedInput).toMatchObject({ name: 'renamed', expectedRevision: 4 });

    service.update = async () => { throw new Error('schedule_revision_conflict: sch_1'); };
    const conflicted = await updateTool.execute({ scheduleId: 'sch_1', name: 'again' }, context);
    expect(conflicted).toMatchObject({ ok: false, code: 'schedule_revision_conflict' });
  });

  it('keeps list and run history compact and applies the default run limit', async () => {
    const service = new RecordingScheduleService();
    const tools = schedulerTools(service);
    const listed = content(await tool(tools, 'schedule_list').execute({}, context));
    expect(listed.schedules[0]).toEqual({
      id: 'sch_1', name: 'existing', enabled: true, targetKind: 'agent',
      spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'UTC' },
      nextRunAt: '2026-08-31T08:00:00.000Z', lastRunAt: null, revision: 4
    });
    expect(JSON.stringify(listed)).not.toContain('original');

    const runs = content(await tool(tools, 'schedule_runs').execute({ scheduleId: 'sch_1' }, context));
    expect(service.listedRunsOptions).toEqual({ limit: 20 });
    expect(runs.runs[0]).toMatchObject({
      id: 'run_1', scheduleId: 'sch_1', status: 'running', deliveryStatus: null,
      deliveryMessageId: null, deliveryError: null
    });
    expect(JSON.stringify(runs)).not.toContain('targetSnapshot');
  });

  it('marks reads replay-safe and every durable mutation replay-never', () => {
    const tools = schedulerTools(new RecordingScheduleService());
    for (const name of ['schedule_list', 'schedule_get', 'schedule_runs']) {
      expect(tool(tools, name).replay).toBe('safe');
    }
    for (const name of [
      'schedule_create', 'schedule_update', 'schedule_set_enabled', 'schedule_delete',
      'schedule_run_now', 'schedule_cancel_run'
    ]) {
      expect(tool(tools, name)).toMatchObject({ replay: 'never', repeatPolicy: 'bounded', risk: 'write' });
    }
  });
});
