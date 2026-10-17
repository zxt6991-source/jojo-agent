import type { JojoAppService } from '@desktop-agent/app-service';
import path from 'node:path';
import type { AgentRuntime, RuntimeRunSnapshot } from '@desktop-agent/agent-runtime';
import {
  AgentScheduleDispatcher,
  AgentScheduleTargetValidator,
  DefaultScheduleCalculator,
  DefaultScheduleService,
  DurableScheduleEngine,
  MemoryScheduleStore,
  ReminderScheduleDispatcher,
  ScheduleDispatcherRegistry,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleEvent,
  type SchedulePrincipal,
  type ScheduleRun,
  type ScheduleRunListOptions,
  type ScheduleService,
  type ScheduleDeliveryService,
  type ScheduleDelivery,
  type ScheduleDeliveryItem,
  type ScheduleTarget,
  type ScheduleTargetValidator,
  type UpdateScheduleInput
} from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '@desktop-agent/storage';

export type HeadlessSchedulerRuntimeOptions = {
  runtime: AgentRuntime;
  application: JojoAppService;
  dataDir?: string;
  instanceId?: string;
  now?: () => Date;
  idGenerator?: () => string;
  deliveryService?: ScheduleDeliveryService;
};

export function committedHeadlessScheduleResult(snapshot: RuntimeRunSnapshot | undefined): string | undefined {
  if (snapshot?.status !== 'completed' || !snapshot.result) return undefined;
  const message = snapshot.result.messages.at(-1);
  if (!message || message.role !== 'assistant' || message.metadata?.internal || !message.content.length ||
    message.content.some((block) => block.type !== 'text')) return undefined;
  return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('').trim() || undefined;
}

class HeadlessScheduleTargetValidator implements ScheduleTargetValidator {
  private readonly agent: AgentScheduleTargetValidator;

  constructor(runtime: AgentRuntime) {
    this.agent = new AgentScheduleTargetValidator(runtime);
  }

  async validate(target: ScheduleTarget): Promise<void> {
    if (target.kind === 'reminder') return;
    if (target.kind !== 'agent') {
      throw new Error(`schedule_target_invalid: Headless Server supports agent and reminder targets; received ${target.kind}.`);
    }
    return this.agent.validate(target);
  }

  validateDelivery(delivery: ScheduleDelivery | undefined): void {
    if (delivery?.voice?.enabled) throw new Error('schedule_delivery_unavailable: Headless Server has no local desktop voice device.');
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
  listDeliveries(runId: string): Promise<ScheduleDeliveryItem[]> { return this.service.listDeliveries(runId); }
  replayDelivery(itemId: string): Promise<ScheduleDeliveryItem> { return this.service.replayDelivery(itemId); }
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
  const dispatcher = new AgentScheduleDispatcher(options.runtime, {
    startRun: (input, laneId) => options.application.startRunHandle({
      requestId: input.run.id,
      principal: { id: 'scheduler', type: 'service', scopes: [] }
    }, input.target.sessionId, {
      laneId, input: input.target.input, providerId: input.target.providerId, model: input.target.model,
      ...(input.target.instructions ? { instructions: input.target.instructions } : {}),
      ...(input.target.budget ? { budget: input.target.budget } : {})
    }, {
      runId: input.executionId, actor: { kind: 'main' },
      trigger: { kind: 'scheduler', id: input.run.id },
      metadata: { scheduleId: input.schedule.id, scheduleRunId: input.run.id }
    })
  });
  registry.register(dispatcher);
  registry.register(new ReminderScheduleDispatcher());
  const engine = new DurableScheduleEngine(
    store,
    calculator,
    registry,
    options.instanceId ?? `server:${process.pid}`,
    {
      ...(options.now ? { now: options.now } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      resultContent: {
        readCommittedResult: async ({ targetKind, executionId }) => {
          if (targetKind !== 'agent') return undefined;
          const persisted = await options.runtime.inspectRun(executionId);
          return committedHeadlessScheduleResult(persisted);
        }
      },
      ...(options.deliveryService ? { deliveryService: options.deliveryService } : {})
    }
  );
  const service = new DefaultScheduleService(store, calculator, engine, {
    validator: new HeadlessScheduleTargetValidator(options.runtime),
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
