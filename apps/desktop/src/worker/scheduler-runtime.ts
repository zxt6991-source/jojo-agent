import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import type { OrchestrationEvent } from '@desktop-agent/contracts';
import type { TeamManager, WorkflowManager } from '@desktop-agent/orchestration';
import {
  AgentScheduleDispatcher,
  DefaultScheduleCalculator,
  DefaultScheduleService,
  DurableScheduleEngine,
  ScheduleDispatcherRegistry,
  type AgentScheduleTarget,
  type ScheduleDispatchRequest,
  type ScheduleEvent,
  type ScheduleDeliveryService,
  type ScheduleService,
  type ScheduleTarget,
  type ScheduleTargetValidator
} from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '@desktop-agent/storage';
import path from 'node:path';
import { TeamMemberScheduleDispatcher } from './team-schedule-dispatcher';
import { WorkflowScheduleDispatcher } from './workflow-schedule-dispatcher';

export type DesktopSchedulerRuntime = {
  service: ScheduleService;
  close(): Promise<void>;
};

export type DesktopSchedulerRuntimeOptions = {
  dataDirectory: string;
  runtime: AgentRuntime;
  teamManager: TeamManager;
  workflowManager: WorkflowManager;
  subscribeOrchestration(listener: (event: OrchestrationEvent) => void): () => void;
  prepareAgent(
    input: ScheduleDispatchRequest<AgentScheduleTarget>,
    laneId: string
  ): Promise<{ dispose(): void } | void>;
  validateTarget(target: ScheduleTarget): Promise<void>;
  emit(event: ScheduleEvent): void;
  deliveryService?: ScheduleDeliveryService;
  instanceId?: string;
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
  const agentDispatcher = new AgentScheduleDispatcher(options.runtime, { prepare: options.prepareAgent });
  const teamDispatcher = new TeamMemberScheduleDispatcher(options.teamManager, options.subscribeOrchestration);
  const workflowDispatcher = new WorkflowScheduleDispatcher(options.workflowManager, options.subscribeOrchestration);
  registry.register(agentDispatcher);
  registry.register(teamDispatcher);
  registry.register(workflowDispatcher);
  const engine = new DurableScheduleEngine(
    store,
    calculator,
    registry,
    options.instanceId ?? `desktop:${process.pid}`,
    options.deliveryService ? { deliveryService: options.deliveryService } : {}
  );
  const service = new DefaultScheduleService(store, calculator, engine, {
    validator: new DesktopScheduleTargetValidator(options.validateTarget)
  });
  const unsubscribe = service.subscribe(options.emit);
  try {
    await service.initialize();
  } catch (error) {
    unsubscribe();
    registry.close();
    agentDispatcher.close();
    teamDispatcher.close();
    workflowDispatcher.close();
    await store.close();
    throw error;
  }
  return {
    service,
    close: async () => {
      unsubscribe();
      await service.close();
      registry.close();
      agentDispatcher.close();
      teamDispatcher.close();
      workflowDispatcher.close();
    }
  };
}
