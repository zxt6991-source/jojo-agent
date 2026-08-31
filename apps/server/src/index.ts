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
import {
  ChannelAdapterRegistry,
  type ChannelAdapterFactory,
  type ChannelSecretResolver
} from '@desktop-agent/channel-core';
import { createFeishuAdapterFactory, createTelegramAdapterFactory } from '@desktop-agent/channel-adapters';
import {
  ChannelApprovalBridge,
  ChannelRuntimeCapability,
  ChannelScheduleDeliveryService,
  DefaultChannelManager,
  JojoAppChannelBridge,
  MemoryChannelStore,
  SqliteChannelStore,
  type ChannelAgentBridge,
  type ChannelStore
} from '@desktop-agent/channel-runtime';
import { createJojoServerCore, type JojoServerCore, type JojoServerCoreOptions } from '@desktop-agent/server-core';
import { createJojoHttpServer, type JojoHttpServer, type JojoHttpServerOptions } from '@desktop-agent/server-http';
import {
  createJojoRuntime,
  type JojoRuntimeCompositionOptions
} from '@desktop-agent/runtime-composition';
import type { ScheduleService } from '@desktop-agent/scheduler';
import { SqliteServerStateStore } from '@desktop-agent/storage';
import { createHeadlessSchedulerRuntime } from './scheduler-runtime.js';

export type HeadlessChannelOptions = {
  secrets: ChannelSecretResolver;
  defaultProviderId: string;
  defaultModel: string;
  store?: ChannelStore;
  factories?: ChannelAdapterFactory[];
  builtInAdapters?: boolean;
};

export type HeadlessServerOptions = Omit<JojoRuntimeCompositionOptions, 'host' | 'approval'> & {
  instanceId?: string;
  dataDir?: string;
  stateStore?: ServerStateStore;
  server?: JojoServerCoreOptions;
  channels?: HeadlessChannelOptions;
};

export type HeadlessServer = {
  runtime: AgentRuntime;
  /** Compatibility facade for existing in-process consumers. */
  service: RuntimeAppService;
  appService: JojoAppService;
  core: JojoServerCore;
  scheduleService: ScheduleService;
  channelManager?: DefaultChannelManager;
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
  const channelStore = options.channels?.store
    ?? (options.channels
      ? options.dataDir
        ? new SqliteChannelStore(path.join(options.dataDir, 'channels.sqlite'))
        : new MemoryChannelStore()
      : undefined);
  const registry = options.channels ? channelRegistry(options.channels) : undefined;
  let channelAgent: ChannelAgentBridge | undefined;
  const channelManager = options.channels && channelStore && registry
    ? new DefaultChannelManager({
      store: channelStore,
      registry,
      secrets: options.channels.secrets,
      agent: {
        ensureSession: (...args) => requireChannelAgent(channelAgent).ensureSession(...args),
        run: (...args) => requireChannelAgent(channelAgent).run(...args)
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {})
    })
    : undefined;
  const runtime = await createJojoRuntime({
    ...options,
    capabilities: [
      ...(options.capabilities ?? []),
      ...(channelManager ? [new ChannelRuntimeCapability(channelManager)] : [])
    ],
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
  let channelApproval: ChannelApprovalBridge | undefined;
  let scheduleService: ScheduleService;
  try {
    if (channelManager && channelStore && options.channels) {
      channelAgent = new JojoAppChannelBridge(appService, {
        defaultProviderId: options.channels.defaultProviderId,
        defaultModel: options.channels.defaultModel,
        ...(options.idGenerator ? { idGenerator: options.idGenerator } : {})
      });
      channelApproval = new ChannelApprovalBridge({
        app: appService, channels: channelManager, activeRuns: channelManager, store: channelStore,
        ...(options.now ? { now: options.now } : {})
      });
      channelManager.setInteractionHandler(channelApproval);
      channelApproval.start();
      await channelManager.start();
    }
    scheduleService = await createHeadlessSchedulerRuntime({
      runtime,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.instanceId ? { instanceId: `scheduler:${options.instanceId}` } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(channelManager ? { deliveryService: new ChannelScheduleDeliveryService(channelManager) } : {})
    });
  } catch (error) {
    await channelApproval?.stop();
    await channelManager?.stop();
    await appService.close();
    throw error;
  }
  const core = createJojoServerCore(appService, {
    ...(options.server ?? {}),
    idempotencyStore: options.server?.idempotencyStore ?? stateStore.idempotency,
    ...(options.instanceId && !options.server?.serverId ? { serverId: options.instanceId } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {}),
    scheduler: scheduleService,
    ...(channelManager ? { channels: channelManager, channelKinds: registry?.list() ?? [] } : {})
  });
  let closed = false;
  return {
    runtime, service, appService, core, scheduleService,
    ...(channelManager ? { channelManager } : {}),
    async close() {
      if (closed) return;
      closed = true;
      await channelApproval?.stop();
      await channelManager?.stop();
      await core.close();
    }
  };
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
    http = await createJojoHttpServer(headless.core, {
      ...(options.http ?? {}),
      ...(headless.channelManager && !options.http?.channelWebhook ? { channelWebhook: headless.channelManager } : {})
    });
  } catch (error) {
    await headless.close();
    throw error;
  }
  return {
    ...headless,
    http,
    listen: () => http.listen(),
    async close() {
      await http.app.close();
      await headless.close();
    }
  };
}

function channelRegistry(options: HeadlessChannelOptions): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  if (options.builtInAdapters !== false) {
    registry.register(createTelegramAdapterFactory());
    registry.register(createFeishuAdapterFactory());
  }
  for (const factory of options.factories ?? []) registry.register(factory);
  return registry;
}

function requireChannelAgent(agent: ChannelAgentBridge | undefined): ChannelAgentBridge {
  if (!agent) throw new Error('channel_agent_bridge_not_ready');
  return agent;
}
