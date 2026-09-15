import { describeProviderConfiguration } from '@desktop-agent/agent-runtime';
import type { ProviderConfig } from '@desktop-agent/contracts';
import type {
  AgentRuntime,
  ModelProviderResolver,
  RuntimeHookResolver,
  RuntimePermissionGate,
  RuntimeResolutionContext,
  RuntimeRunContext,
  RuntimeRunContextResolver,
  RuntimeToolSource,
  TelemetrySink,
  ToolResolver
} from '@desktop-agent/agent-runtime';
import { resolveModelForRun, type ModelConfig, NoopHookRuntime, type HookRuntime, type ModelProvider } from '@desktop-agent/contracts';

export type RuntimeExecutionEnvironment = {
  provider: ModelProvider;
  /** Host configuration used to construct this exact provider instance. */
  providerConfig: Pick<ProviderConfig, 'id' | 'protocol' | 'baseUrl' | 'models'>;
  models?: ModelConfig[];
  tools: RuntimeToolSource;
  permissions: RuntimePermissionGate;
  hooks?: HookRuntime;
  telemetry?: TelemetrySink;
  runContext?: RuntimeRunContext;
};

export type RuntimeEnvironmentBinding = {
  dispose(): void;
};

function environmentKey(sessionId: string, laneId: string): string {
  return `${sessionId}\u0000${laneId}`;
}

/**
 * Routes lane-specific product capabilities into one shared AgentRuntime.
 * Hosts register short-lived execution environments; the Runtime remains the
 * sole owner of Session/Lane/Run semantics and lifecycle.
 */
export class RuntimeEnvironmentRegistry {
  private readonly environments = new Map<string, { token: symbol; value: RuntimeExecutionEnvironment }>();

  readonly providers: ModelProviderResolver = {
    describe: (context) => {
      const config = this.resolve(context).providerConfig;
      if (!config || config.id !== context.providerId) throw new Error('runtime_resume_provider_unavailable');
      return describeProviderConfiguration(config, context.model);
    },
    resolve: (context) => {
      const value = this.resolve(context);
      if (!value.providerConfig || value.providerConfig.id !== context.providerId) throw new Error('runtime_resume_provider_unavailable');
      describeProviderConfiguration(value.providerConfig, context.model);
      return value.provider;
    },
    resolveLimits: (context, request) => {
      const models = this.resolve(context).models;
      return models ? resolveModelForRun({ models }, context.model, request) : undefined;
    }
  };

  readonly tools: ToolResolver = {
    resolve: (context) => this.resolve(context).tools
  };

  readonly permissions: RuntimePermissionGate = {
    check: (call, context) => {
      const environment = this.resolve(context);
      const workingDirectory = context.executionScope.kind === 'workspace'
        ? context.executionScope.workingDirectory
        : '';
      return environment.permissions.check(call, {
        ...context,
        workingDirectory
      });
    }
  };

  readonly hooks: RuntimeHookResolver = {
    resolve: (context) => this.resolve(context).hooks ?? NoopHookRuntime.instance
  };

  readonly telemetry: TelemetrySink = {
    diagnostic: (event, context) => this.resolve(context).telemetry?.diagnostic(event, context)
  };

  readonly runContext: RuntimeRunContextResolver = {
    resolve: (context) => this.resolve(context).runContext ?? {}
  };

  bind(sessionId: string, laneId: string, value: RuntimeExecutionEnvironment): RuntimeEnvironmentBinding {
    const key = environmentKey(sessionId, laneId);
    const token = Symbol(key);
    this.environments.set(key, { token, value: { ...value, providerConfig: structuredClone(value.providerConfig) } });
    return {
      dispose: () => {
        if (this.environments.get(key)?.token === token) this.environments.delete(key);
      }
    };
  }

  has(sessionId: string, laneId: string): boolean {
    return this.environments.has(environmentKey(sessionId, laneId));
  }

  private resolve(context: Pick<RuntimeResolutionContext, 'sessionId' | 'laneId'>): RuntimeExecutionEnvironment {
    const environment = this.environments.get(environmentKey(context.sessionId, context.laneId))?.value;
    if (!environment) throw new Error(`runtime_environment_unavailable: ${context.sessionId}/${context.laneId}`);
    return environment;
  }
}

export type SharedRuntimeService = {
  runtime: AgentRuntime | Promise<AgentRuntime>;
  environments: RuntimeEnvironmentRegistry;
};
