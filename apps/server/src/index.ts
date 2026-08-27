import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import { createRuntimeAppService, type RuntimeAppService } from '@desktop-agent/app-service';
import {
  createJojoRuntime,
  type JojoRuntimeCompositionOptions
} from '@desktop-agent/runtime-composition';

export type HeadlessServerOptions = Omit<JojoRuntimeCompositionOptions, 'host'> & {
  instanceId?: string;
};

export type HeadlessServer = {
  runtime: AgentRuntime;
  service: RuntimeAppService;
  close(): Promise<void>;
};

/** Creates the Server Host without Electron, IPC, UtilityProcess, or a Renderer. */
export async function createHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServer> {
  const runtime = await createJojoRuntime({
    ...options,
    host: {
      kind: 'server',
      ...(options.instanceId ? { instanceId: options.instanceId } : {})
    }
  });
  const service = createRuntimeAppService(runtime);
  return { runtime, service, close: () => service.close() };
}
