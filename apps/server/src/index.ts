import path from 'node:path';
import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import {
  createJojoAppService,
  createRuntimeAppService,
  MemoryServerStateStore,
  ServerRecoveryCoordinator,
  ServerApprovalBroker,
  type JojoAppService,
  type RuntimeAppService,
  type ServerStateStore
} from '@desktop-agent/app-service';
import { createJojoServerCore, type JojoServerCore, type JojoServerCoreOptions } from '@desktop-agent/server-core';
import { createJojoHttpServer, type JojoHttpServer, type JojoHttpServerOptions } from '@desktop-agent/server-http';
import {
  createJojoRuntime,
  type JojoRuntimeCompositionOptions
} from '@desktop-agent/runtime-composition';
import type { ScheduleService } from '@desktop-agent/scheduler';
import { SqliteServerStateStore } from '@desktop-agent/storage';
import { createHeadlessSchedulerRuntime } from './scheduler-runtime.js';

export type HeadlessServerOptions = Omit<JojoRuntimeCompositionOptions, 'host' | 'approval'> & {
  instanceId?: string;
  dataDir?: string;
  stateStore?: ServerStateStore;
  server?: JojoServerCoreOptions;
};

export type HeadlessServer = {
  runtime: AgentRuntime;
  /** Compatibility facade for existing in-process consumers. */
  service: RuntimeAppService;
  appService: JojoAppService;
  core: JojoServerCore;
  scheduleService: ScheduleService;
  close(): Promise<void>;
};

/** Creates the Server Host without Electron, IPC, UtilityProcess, or a Renderer. */
export async function createHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServer> {
  const stateStore = options.stateStore
    ?? (options.dataDir
      ? new SqliteServerStateStore(path.join(options.dataDir, 'server-state.sqlite'), {
        now: () => options.now?.().getTime() ?? Date.now()
      })
      : new MemoryServerStateStore(options.now));
  const approvalBroker = new ServerApprovalBroker({
    store: stateStore.approvals,
    ...(options.now ? { now: options.now } : {})
  });
  const runtime = await createJojoRuntime({
    ...options,
    approval: approvalBroker,
    host: {
      kind: 'server',
      ...(options.instanceId ? { instanceId: options.instanceId } : {})
    }
  });
  await new ServerRecoveryCoordinator(runtime, stateStore).reconcile();
  const service = createRuntimeAppService(runtime);
  const appService = createJojoAppService(runtime, {
    approvalBroker,
    stateStore,
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  let scheduleService: ScheduleService;
  try {
    scheduleService = await createHeadlessSchedulerRuntime({
      runtime,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.instanceId ? { instanceId: `scheduler:${options.instanceId}` } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.now ? { now: options.now } : {})
    });
  } catch (error) {
    await appService.close();
    throw error;
  }
  const core = createJojoServerCore(appService, {
    ...(options.server ?? {}),
    idempotencyStore: options.server?.idempotencyStore ?? stateStore.idempotency,
    ...(options.instanceId && !options.server?.serverId ? { serverId: options.instanceId } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {}),
    scheduler: scheduleService
  });
  return { runtime, service, appService, core, scheduleService, close: () => core.close() };
}

export type NetworkServerOptions = HeadlessServerOptions & {
  http?: JojoHttpServerOptions;
};

export type NetworkServer = HeadlessServer & {
  http: JojoHttpServer;
  listen(): Promise<string>;
};

export async function createNetworkServer(options: NetworkServerOptions): Promise<NetworkServer> {
  const headless = await createHeadlessServer(options);
  let http: JojoHttpServer;
  try {
    http = await createJojoHttpServer(headless.core, options.http);
  } catch (error) {
    await headless.close();
    throw error;
  }
  return {
    ...headless,
    http,
    listen: () => http.listen(),
    close: () => http.close()
  };
}
