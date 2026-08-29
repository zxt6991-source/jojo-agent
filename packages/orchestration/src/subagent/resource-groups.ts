import type { WorkflowResourceGroup, WorkflowStep } from '@desktop-agent/contracts';
import { abortError } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import type { ProviderSemaphore } from './provider-semaphore.js';
import { AgentExecutionScheduler } from './scheduler.js';

export class ResourceGroupLimiter {
  private readonly groups = new Map<string, AgentExecutionScheduler>();

  register(resources: WorkflowResourceGroup): AgentExecutionScheduler {
    const existing = this.groups.get(resources.group);
    if (existing) {
      if (existing.maxConcurrent !== resources.maxConcurrency) {
        throw new OrchestrationError(
          'resource_group_conflict',
          `Resource group ${resources.group} is already limited to ${existing.maxConcurrent}.`
        );
      }
      return existing;
    }
    const limiter = new AgentExecutionScheduler(resources.maxConcurrency);
    this.groups.set(resources.group, limiter);
    return limiter;
  }

  reconfigure(resources: WorkflowResourceGroup): AgentExecutionScheduler {
    const existing = this.groups.get(resources.group);
    if (existing?.activeCount || existing?.queuedCount) {
      throw new OrchestrationError('resource_group_conflict', `Resource group ${resources.group} is active and cannot be reconfigured.`);
    }
    const limiter = new AgentExecutionScheduler(resources.maxConcurrency);
    this.groups.set(resources.group, limiter);
    return limiter;
  }

  acquire(resources: WorkflowResourceGroup, signal: AbortSignal): Promise<() => void> {
    return this.register(resources).acquire(signal);
  }

  activeCount(group: string): number {
    return this.groups.get(group)?.activeCount ?? 0;
  }

  queuedCount(group: string): number {
    return this.groups.get(group)?.queuedCount ?? 0;
  }
}

export function workflowStepResources(step: WorkflowStep): WorkflowResourceGroup | undefined {
  if (step.type === 'agent') return step.resources;
  if (step.type === 'foreach' && step.template.type === 'agent') return step.template.resources;
  return undefined;
}

export async function acquireResourceAndAgentSlots(input: {
  resourceGroups: ResourceGroupLimiter;
  signal: AbortSignal;
  resources?: WorkflowResourceGroup;
  providers?: ProviderSemaphore;
  providerId?: string;
  scheduler?: AgentExecutionScheduler;
}): Promise<() => void> {
  if (input.signal.aborted) return Promise.reject(abortError());
  const releases: Array<() => void> = [];
  try {
    if (input.resources) releases.push(await input.resourceGroups.acquire(input.resources, input.signal));
    if (input.providers && input.providerId) {
      releases.push(await input.providers.acquire(input.providerId, input.signal));
    }
    if (input.scheduler) releases.push(await input.scheduler.acquire(input.signal));
    return () => {
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]!();
    };
  } catch (error) {
    for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]!();
    throw error;
  }
}
