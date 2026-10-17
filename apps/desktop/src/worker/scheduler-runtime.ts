import type { JojoAppService } from '@desktop-agent/app-service';
import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import type { OrchestrationEvent, ResultContentPort, SpeechSettings, WorkerMessage } from '@desktop-agent/contracts';
import type { TeamManager, WorkflowManager } from '@desktop-agent/orchestration';
import {
  AgentScheduleDispatcher,
  DefaultScheduleCalculator,
  DefaultScheduleService,
  DurableScheduleEngine,
  ScheduleDispatcherRegistry,
  ReminderScheduleDispatcher,
  LegacyScheduleDeliveryAdapter,
  type AgentScheduleTarget,
  type ScheduleDispatchRequest,
  type ScheduleEvent,
  type ScheduleDeliveryService,
  type ScheduleService,
  type ScheduleStore,
  type ScheduleTarget,
  type ScheduleTargetValidator
} from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '@desktop-agent/storage';
import path from 'node:path';
import { TeamMemberScheduleDispatcher } from './team-schedule-dispatcher';
import { WorkflowScheduleDispatcher } from './workflow-schedule-dispatcher';
import { DesktopScheduleDeliveryAdapter, scheduleVoicePresetVersion } from './schedule-desktop-delivery';
import type { DesktopSpeechRuntime } from './speech-runtime';

export type DesktopSchedulerRuntime = {
  service: ScheduleService;
  store: ScheduleStore;
  desktopDelivery?: DesktopScheduleDeliveryAdapter;
  resume(): void;
  close(): Promise<void>;
};

export type DesktopSchedulerRuntimeOptions = {
  dataDirectory: string;
  runtime: AgentRuntime;
  application: JojoAppService;
  teamManager: Pick<TeamManager, 'getTask' | 'delegate' | 'cancel'>;
  workflowManager: Pick<WorkflowManager, 'get' | 'start' | 'cancel'>;
  subscribeOrchestration(listener: (event: OrchestrationEvent) => void): () => void;
  prepareAgent(
    input: ScheduleDispatchRequest<AgentScheduleTarget>,
    laneId: string
  ): Promise<{ dispose(): void } | void>;
  validateTarget(target: ScheduleTarget): Promise<void>;
  emit(event: ScheduleEvent): void;
  deliveryService?: ScheduleDeliveryService;
  instanceId?: string;
  resultContent?: ResultContentPort;
  desktop?: { speech: DesktopSpeechRuntime; readSettings(): SpeechSettings; post(message: WorkerMessage): void };
};

class DesktopScheduleTargetValidator implements ScheduleTargetValidator {
  constructor(private readonly validateTarget: (target: ScheduleTarget) => Promise<void>) {}
  validate(target: ScheduleTarget): Promise<void> { return this.validateTarget(target); }
}

export async function createDesktopSchedulerRuntime(
  options: DesktopSchedulerRuntimeOptions
): Promise<DesktopSchedulerRuntime> {
  const store = new SqliteScheduleStore(path.join(options.dataDirectory, 'runtime', 'scheduler.sqlite'));
  const calculator = new DefaultScheduleCalculator();
  const registry = new ScheduleDispatcherRegistry();
  const agentDispatcher = new AgentScheduleDispatcher(options.runtime, {
    prepare: options.prepareAgent,
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
  const teamDispatcher = new TeamMemberScheduleDispatcher(options.teamManager, options.subscribeOrchestration);
  const workflowDispatcher = new WorkflowScheduleDispatcher(options.workflowManager, options.subscribeOrchestration);
  registry.register(agentDispatcher);
  registry.register(teamDispatcher);
  registry.register(workflowDispatcher);
  registry.register(new ReminderScheduleDispatcher());
  const desktopDelivery = options.desktop ? new DesktopScheduleDeliveryAdapter({ ...options.desktop, store: () => store }) : undefined;
  const legacyDelivery = options.deliveryService ? new LegacyScheduleDeliveryAdapter(store, options.deliveryService) : undefined;
  const engine = new DurableScheduleEngine(
    store,
    calculator,
    registry,
    options.instanceId ?? `desktop:${process.pid}`,
    {
      ...(options.deliveryService ? { deliveryService: options.deliveryService } : {}),
      ...(options.resultContent ? { resultContent: options.resultContent } : {}),
      ...(options.desktop ? { voicePresetVersion: presetId => {
        try { return scheduleVoicePresetVersion(options.desktop!.readSettings(), presetId); }
        catch { return 'unavailable'; }
      } } : {}),
      ...(desktopDelivery ? { deliveryAdapter: { deliver: (item, context) =>
        item.destination === 'voice' || item.destination === 'notification'
          ? desktopDelivery.deliver(item, context)
          : legacyDelivery?.deliver(item, context) ?? Promise.resolve({ status: 'suppressed' as const, reason: 'delivery_not_configured' }),
        inspect: item => item.destination === 'voice' || item.destination === 'notification'
          ? Promise.resolve({ status: 'deferred' as const })
          : legacyDelivery?.inspect(item) ?? Promise.resolve({ status: 'suppressed' as const, reason: 'delivery_not_configured' }) } } : {})
    }
  );
  const service = new DefaultScheduleService(store, calculator, engine, {
    validator: new DesktopScheduleTargetValidator(options.validateTarget)
  });
  const unsubscribe = service.subscribe(event => {
    options.emit(event);
    if (event.type === 'schedule.changed') {
      if (event.schedule.delivery?.voice?.enabled) void desktopDelivery?.precache(event.schedule);
      else desktopDelivery?.releaseSchedule(event.schedule.id);
    }
    if (event.type === 'schedule.deleted') desktopDelivery?.releaseSchedule(event.scheduleId);
  });
  try {
    await service.initialize();
  } catch (error) {
    unsubscribe();
    desktopDelivery?.close();
    registry.close();
    agentDispatcher.close();
    teamDispatcher.close();
    workflowDispatcher.close();
    await store.close();
    throw error;
  }
  return {
    service,
    store,
    ...(desktopDelivery ? { desktopDelivery } : {}),
    resume: () => engine.poke(),
    close: async () => {
      unsubscribe();
      desktopDelivery?.close();
      await service.close();
      registry.close();
      agentDispatcher.close();
      teamDispatcher.close();
      workflowDispatcher.close();
    }
  };
}
