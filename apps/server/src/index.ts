import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import {
  createJojoAppService,
  createRuntimeAppService,
  ServerApprovalBroker,
  type JojoAppService,
  type RuntimeAppService
} from '@desktop-agent/app-service';
import { createJojoServerCore, type JojoServerCore, type JojoServerCoreOptions } from '@desktop-agent/server-core';
import { createJojoHttpServer, type JojoHttpServer, type JojoHttpServerOptions } from '@desktop-agent/server-http';
import {
  createJojoRuntime,
  type JojoRuntimeCompositionOptions
} from '@desktop-agent/runtime-composition';

export type HeadlessServerOptions = Omit<JojoRuntimeCompositionOptions, 'host' | 'approval'> & {
  instanceId?: string;
  server?: JojoServerCoreOptions;
};

export type HeadlessServer = {
  runtime: AgentRuntime;
  /** Compatibility facade for existing in-process consumers. */
  service: RuntimeAppService;
  appService: JojoAppService;
  core: JojoServerCore;
  close(): Promise<void>;
};

/** Creates the Server Host without Electron, IPC, UtilityProcess, or a Renderer. */
export async function createHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServer> {
  const approvalBroker = new ServerApprovalBroker(options.now);
  const runtime = await createJojoRuntime({
    ...options,
    approval: approvalBroker,
    host: {
      kind: 'server',
      ...(options.instanceId ? { instanceId: options.instanceId } : {})
    }
  });
  const service = createRuntimeAppService(runtime);
  const appService = createJojoAppService(runtime, { approvalBroker, ...(options.now ? { now: options.now } : {}) });
  const core = createJojoServerCore(appService, {
    ...(options.server ?? {}),
    ...(options.instanceId && !options.server?.serverId ? { serverId: options.instanceId } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  return { runtime, service, appService, core, close: () => appService.close() };
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
  const http = await createJojoHttpServer(headless.core, options.http);
  return {
    ...headless,
    http,
    listen: () => http.listen(),
    close: () => http.close()
  };
}
