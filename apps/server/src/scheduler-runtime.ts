import path from 'node:path';
import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import {
  AgentScheduleDispatcher,
  AgentScheduleTargetValidator,
  DefaultScheduleCalculator,
  DefaultScheduleService,
  DurableScheduleEngine,
  MemoryScheduleStore,
  ScheduleDispatcherRegistry,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleEvent,
  type SchedulePrincipal,
  type ScheduleRun,
  type ScheduleRunListOptions,
  type ScheduleService,
  type ScheduleDeliveryService,
  type ScheduleTarget,
  type ScheduleTargetValidator,
  type UpdateScheduleInput
} from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '@desktop-agent/storage';

export type HeadlessSchedulerRuntimeOptions = {
  runtime: AgentRuntime;
  dataDir?: string;
  instanceId?: string;
  now?: () => Date;
  idGenerator?: () => string;
  deliveryService?: ScheduleDeliveryService;
};

class HeadlessAgentTargetValidator implements ScheduleTargetValidator {
  private readonly agent: AgentScheduleTargetValidator;

  constructor(runtime: AgentRuntime) {
    this.agent = new AgentScheduleTargetValidator(runtime);
  }

  validate(target: ScheduleTarget): Promise<void> {
    if (target.kind !== 'agent') {
      throw new Error(`schedule_target_invalid: Headless Server only supports agent targets; received ${target.kind}.`);
    }
    return this.agent.validate(target);
  }
}

class ManagedScheduleService implements ScheduleService {
  private closed = false;

  constructor(
    private readonly service: DefaultScheduleService,
    private readonly registry: ScheduleDispatcherRegistry,
    private readonly dispatcher: AgentScheduleDispatcher
  ) {}

  initialize(): Promise<void> { return this.service.initialize(); }
  list(): Promise<Schedule[]> { return this.service.list(); }
  get(id: string): Promise<Schedule> { return this.service.get(id); }
  create(input: CreateScheduleInput, principal: SchedulePrincipal): Promise<Schedule> {
    return this.service.create(input, principal);
  }
  update(id: string, input: UpdateScheduleInput): Promise<Schedule> { return this.service.update(id, input); }
  setEnabled(id: string, enabled: boolean, expectedRevision?: number): Promise<Schedule> {
    return this.service.setEnabled(id, enabled, expectedRevision);
  }
  delete(id: string): Promise<void> { return this.service.delete(id); }
  runNow(id: string, options?: { respectConcurrency?: boolean }): Promise<ScheduleRun> {
    return this.service.runNow(id, options);
  }
  listRuns(id: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]> {
    return this.service.listRuns(id, options);
  }
  getRun(runId: string): Promise<ScheduleRun> { return this.service.getRun(runId); }
  cancelRun(runId: string): Promise<void> { return this.service.cancelRun(runId); }
  subscribe(listener: (event: ScheduleEvent) => void): () => void { return this.service.subscribe(listener); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.service.close();
    this.registry.close();
    this.dispatcher.close();
  }
}

export async function createHeadlessSchedulerRuntime(
  options: HeadlessSchedulerRuntimeOptions
): Promise<ScheduleService> {
  const store = options.dataDir
    ? new SqliteScheduleStore(path.join(options.dataDir, 'scheduler.sqlite'))
    : new MemoryScheduleStore();
  const calculator = new DefaultScheduleCalculator();
  const registry = new ScheduleDispatcherRegistry();
  const dispatcher = new AgentScheduleDispatcher(options.runtime);
  registry.register(dispatcher);
  const engine = new DurableScheduleEngine(
    store,
    calculator,
    registry,
    options.instanceId ?? `server:${process.pid}`,
    {
      ...(options.now ? { now: options.now } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.deliveryService ? { deliveryService: options.deliveryService } : {})
    }
  );
  const service = new DefaultScheduleService(store, calculator, engine, {
    validator: new HeadlessAgentTargetValidator(options.runtime),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {})
  });
  const managed = new ManagedScheduleService(service, registry, dispatcher);
  try {
    await managed.initialize();
    return managed;
  } catch (error) {
    await managed.close();
    throw error;
  }
}
