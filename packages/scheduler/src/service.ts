import type { ScheduleCalculator } from './calculator.js';
import type { DurableScheduleEngine } from './engine.js';
import { ScheduleEventBus } from './events.js';
import type { ScheduleStore } from './store.js';
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleEvent,
  SchedulePrincipal,
  ScheduleRun,
  ScheduleRunListOptions,
  ScheduleTarget,
  UpdateScheduleInput
} from './types.js';

const DEFAULT_MISFIRE = { kind: 'fire_once' as const, graceMs: 24 * 60 * 60_000 };

export interface ScheduleTargetValidator {
  validate(target: ScheduleTarget): Promise<void> | void;
}

export interface ScheduleService {
  initialize(): Promise<void>;
  list(): Promise<Schedule[]>;
  get(id: string): Promise<Schedule>;
  create(input: CreateScheduleInput, principal: SchedulePrincipal): Promise<Schedule>;
  update(id: string, input: UpdateScheduleInput): Promise<Schedule>;
  setEnabled(id: string, enabled: boolean, expectedRevision?: number): Promise<Schedule>;
  delete(id: string): Promise<void>;
  runNow(id: string, options?: { respectConcurrency?: boolean }): Promise<ScheduleRun>;
  listRuns(id: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]>;
  getRun(runId: string): Promise<ScheduleRun>;
  cancelRun(runId: string): Promise<void>;
  subscribe(listener: (event: ScheduleEvent) => void): () => void;
  close(): Promise<void>;
}

export type DefaultScheduleServiceOptions = {
  now?: () => Date;
  idGenerator?: () => string;
  validator?: ScheduleTargetValidator;
};

export class DefaultScheduleService implements ScheduleService {
  private readonly events = new ScheduleEventBus();
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly validator: ScheduleTargetValidator | undefined;
  private readonly unsubscribeEngine: () => void;

  constructor(
    private readonly store: ScheduleStore,
    private readonly calculator: ScheduleCalculator,
    private readonly engine: DurableScheduleEngine,
    options: DefaultScheduleServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.validator = options.validator;
    this.unsubscribeEngine = engine.subscribe((event) => this.events.emit(event));
  }

  initialize(): Promise<void> { return this.engine.initialize(); }
  list(): Promise<Schedule[]> { return this.store.list(); }

  async get(id: string): Promise<Schedule> {
    const schedule = await this.store.get(id);
    if (!schedule || schedule.deletedAt) throw new Error(`schedule_not_found: ${id}`);
    return schedule;
  }

  async create(input: CreateScheduleInput, principal: SchedulePrincipal): Promise<Schedule> {
    this.validateInput(input);
    await this.validator?.validate(input.target);
    const now = this.now();
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? this.initialNext(input.spec, now) : undefined;
    const schedule = await this.store.create({
      id: `sch_${this.idGenerator()}`,
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      enabled,
      spec: input.spec,
      target: input.target,
      misfire: input.misfire ?? DEFAULT_MISFIRE,
      concurrency: input.concurrency ?? 'skip',
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
      revision: 1,
      createdBy: principal.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    this.events.emit({ type: 'schedule.changed', schedule });
    this.engine.poke();
    return schedule;
  }

  async update(id: string, input: UpdateScheduleInput): Promise<Schedule> {
    const current = await this.get(id);
    const mergedInput: CreateScheduleInput = {
      name: input.name ?? current.name,
      ...(input.description !== undefined ? { description: input.description } : current.description ? { description: current.description } : {}),
      enabled: input.enabled ?? current.enabled,
      spec: input.spec ?? current.spec,
      target: input.target ?? current.target,
      misfire: input.misfire ?? current.misfire,
      concurrency: input.concurrency ?? current.concurrency
    };
    this.validateInput(mergedInput);
    if (input.target) await this.validator?.validate(input.target);
    const now = this.now();
    const recalculates = input.spec !== undefined || input.enabled === true;
    const nextRunAt = mergedInput.enabled
      ? recalculates
        ? this.initialNext(mergedInput.spec, now)
        : current.nextRunAt ? new Date(current.nextRunAt) : this.initialNext(mergedInput.spec, now)
      : undefined;
    const base = { ...current };
    delete base.description;
    delete base.nextRunAt;
    const updated = await this.store.update({
      ...base,
      name: mergedInput.name.trim(),
      ...(mergedInput.description?.trim() ? { description: mergedInput.description.trim() } : {}),
      enabled: mergedInput.enabled ?? true,
      spec: mergedInput.spec,
      target: mergedInput.target,
      misfire: mergedInput.misfire ?? DEFAULT_MISFIRE,
      concurrency: mergedInput.concurrency ?? 'skip',
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
      updatedAt: now.toISOString()
    }, input.expectedRevision);
    this.events.emit({ type: 'schedule.changed', schedule: updated });
    this.engine.poke();
    return updated;
  }

  setEnabled(id: string, enabled: boolean, expectedRevision?: number): Promise<Schedule> {
    return this.update(id, { enabled, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.store.softDelete(id, this.now().toISOString());
    this.events.emit({ type: 'schedule.deleted', scheduleId: id });
    this.engine.poke();
  }

  async runNow(id: string, options?: { respectConcurrency?: boolean }): Promise<ScheduleRun> {
    return this.engine.runNow(await this.get(id), options);
  }

  async listRuns(id: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]> {
    if (!await this.store.get(id)) throw new Error(`schedule_not_found: ${id}`);
    return this.store.listRuns(id, options);
  }

  async getRun(runId: string): Promise<ScheduleRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`schedule_run_not_found: ${runId}`);
    return run;
  }

  cancelRun(runId: string): Promise<void> { return this.engine.cancelRun(runId); }
  subscribe(listener: (event: ScheduleEvent) => void): () => void { return this.events.subscribe(listener); }

  async close(): Promise<void> {
    this.unsubscribeEngine();
    await this.engine.close();
    await this.store.close?.();
    this.events.clear();
  }

  private validateInput(input: CreateScheduleInput): void {
    if (!input.name.trim()) throw new Error('schedule_invalid_spec: Schedule name is required.');
    this.calculator.validate(input.spec);
    if (input.misfire?.kind === 'fire_once' && (!Number.isSafeInteger(input.misfire.graceMs) || input.misfire.graceMs < 0)) {
      throw new Error('schedule_invalid_spec: Misfire grace must be a non-negative integer.');
    }
    const concurrency = input.concurrency ?? 'skip';
    if (input.target.kind === 'agent' && concurrency === 'allow') {
      throw new Error('schedule_invalid_spec: Agent targets cannot use allow concurrency with a persistent lane.');
    }
    if ((input.target.kind === 'agent' || input.target.kind === 'workflow')
      && (!input.target.providerId || !input.target.model)) {
      throw new Error('schedule_target_invalid: Provider and model are required.');
    }
  }

  private initialNext(spec: Schedule['spec'], now: Date): Date {
    if (spec.kind === 'once') {
      const runAt = new Date(spec.runAt);
      if (runAt.getTime() <= now.getTime()) {
        throw new Error('schedule_invalid_spec: A once schedule must be in the future.');
      }
      return runAt;
    }
    const next = this.calculator.nextAfter(spec, now);
    if (!next) throw new Error('schedule_invalid_spec: The schedule has no future occurrence.');
    return next;
  }
}
