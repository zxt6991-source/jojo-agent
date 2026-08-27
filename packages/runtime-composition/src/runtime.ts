import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type ApprovalBroker,
  type MemoryRuntime,
  type ModelProviderResolver,
  type RuntimeHostDescriptor,
  type RuntimeHookResolver,
  type RuntimeResolutionContext,
  type RuntimePermissionGate,
  type RuntimeRunContextResolver,
  type RuntimeSummarizer,
  type RuntimeToolSource,
  type TelemetrySink,
  type ToolResolver,
  type ToolSnapshotContext
} from '@desktop-agent/agent-runtime';
import type { HookRuntime, Tool } from '@desktop-agent/contracts';
import type { AgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';

export interface RuntimeDisposable {
  dispose(): void | Promise<void>;
}

export type RuntimeToolSourceFactory = (
  context: RuntimeResolutionContext
) => RuntimeToolSource | Promise<RuntimeToolSource>;

export interface RuntimeCapability {
  contribute(builder: RuntimeEnvironmentBuilder): void | Promise<void>;
}

export type JojoRuntimeCompositionOptions = {
  host: RuntimeHostDescriptor;
  providers: ModelProviderResolver;
  permissions: RuntimePermissionGate;
  store?: AgentRuntimeStore;
  tools?: ToolResolver;
  approval?: ApprovalBroker;
  summarizer?: RuntimeSummarizer;
  memory?: MemoryRuntime;
  hooks?: HookRuntime | RuntimeHookResolver;
  runContext?: RuntimeRunContextResolver;
  telemetry?: TelemetrySink;
  capabilities?: RuntimeCapability[];
  idGenerator?: AgentRuntimeOptions['idGenerator'];
  now?: AgentRuntimeOptions['now'];
};

export class RuntimeEnvironmentBuilder {
  private readonly toolFactories: RuntimeToolSourceFactory[] = [];
  private readonly disposables: RuntimeDisposable[] = [];

  addToolSource(factory: RuntimeToolSourceFactory): this {
    this.toolFactories.push(factory);
    return this;
  }

  addTools(tools: Tool[] | (() => Tool[])): this {
    return this.addToolSource(() => ({
      snapshot: () => typeof tools === 'function' ? tools() : tools
    }));
  }

  addDisposable(disposable: RuntimeDisposable): this {
    this.disposables.push(disposable);
    return this;
  }

  toolResolver(): ToolResolver {
    const factories = [...this.toolFactories];
    return {
      resolve: async (context) => {
        const sources = await Promise.all(factories.map((factory) => factory(context)));
        return compositeToolSource(sources);
      }
    };
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.disposables].reverse().map((item) => item.dispose()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

function compositeToolSource(sources: RuntimeToolSource[]): RuntimeToolSource {
  return {
    snapshot(context: ToolSnapshotContext): Tool[] {
      const tools = sources.flatMap((source) => source.snapshot(context));
      return [...new Map(tools.map((tool) => [tool.definition.name, tool])).values()];
    },
    async dispose(): Promise<void> {
      await Promise.allSettled([...sources].reverse().map((source) => source.dispose?.()));
    }
  };
}

export async function createJojoRuntime(options: JojoRuntimeCompositionOptions): Promise<AgentRuntime> {
  const builder = new RuntimeEnvironmentBuilder();
  if (options.tools) builder.addToolSource((context) => options.tools!.resolve(context));
  for (const capability of options.capabilities ?? []) await capability.contribute(builder);

  return createAgentRuntime({
    ...(options.store ? { store: options.store } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {}),
    environment: {
      host: options.host,
      providers: options.providers,
      tools: builder.toolResolver(),
      permissions: options.permissions,
      ...(options.approval ? { approval: options.approval } : {}),
      ...(options.summarizer ? { summarizer: options.summarizer } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.runContext ? { runContext: options.runContext } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      dispose: () => builder.dispose()
    }
  });
}
