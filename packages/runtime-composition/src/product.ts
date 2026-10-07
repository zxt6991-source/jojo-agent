import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import {
  ApplicationRecoveryCoordinator, MemoryServerStateStore, createJojoAppService,
  type JojoAppService, type JojoAppServiceOptions
} from '@desktop-agent/app-service';
import { createJojoRuntime, type JojoRuntimeCompositionOptions } from './runtime.js';

export type ProductRuntimeOptions = {
  runtime: JojoRuntimeCompositionOptions;
  application?: JojoAppServiceOptions;
  recovery: 'interrupt' | 'preserve';
  /** Host-owned repair (such as file tombstones) must finish before recovery and dispatch. */
  beforeRecovery?: (runtime: AgentRuntime) => Promise<void>;
};

export type ProductRuntime = {
  runtime: AgentRuntime;
  application: JojoAppService;
  close(): Promise<void>;
};

/** Owns Runtime and application-state lifetime; transports and Host resources remain outside. */
export async function createProductRuntime(options: ProductRuntimeOptions): Promise<ProductRuntime> {
  const stateStore = options.application?.stateStore ?? new MemoryServerStateStore(options.application?.now);
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await createJojoRuntime({
      ...options.runtime,
      ...(options.application?.approvalBroker ? { approval: options.application.approvalBroker } : {})
    });
    await options.beforeRecovery?.(runtime);
    await new ApplicationRecoveryCoordinator(runtime, stateStore, {
      preservePendingOperations: options.recovery === 'preserve'
    }).reconcile();
    const application = createJojoAppService(runtime, { ...options.application, stateStore });
    return { runtime, application, close: () => application.close() };
  } catch (error) {
    await Promise.allSettled([runtime?.close(), stateStore.close()]);
    throw error;
  }
}
