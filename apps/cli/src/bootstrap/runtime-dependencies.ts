import { MODEL_METADATA_TTL_MS, resolveEffectiveModelLimits, type ModelConfig } from '@desktop-agent/contracts';
import { randomUUID } from 'node:crypto';
import type { RuntimePermissionGate, TelemetrySink } from '@desktop-agent/agent-runtime';
import type { ChannelSecretResolver } from '@desktop-agent/channel-core';
import { mergeRefreshedModels, ModelDiscoveryRefresh, resolveModelMetadata, OpenAICompatibleProvider } from '@desktop-agent/providers';
import type { Logger } from 'pino';
import { ExitCode, JojoCliError } from '../errors.js';
import { resolveSecret, secretEnvironmentName } from '../config/redact.js';
import type { EffectiveConfig } from '../config/schema.js';

export function createRuntimeDependencies(config: EffectiveConfig, logger: Logger) {
  const metadata = new Map<string, { models: ModelConfig[]; refreshAfter: number }>();
  const refresh = new ModelDiscoveryRefresh();
  const providers = {
    resolveLimits: async (context: { providerId: string; model: string }, request?: { maxOutputTokens?: number }) => {
      const configured = config.provider.providers[context.providerId];
      const cached = metadata.get(context.providerId);
      let models = cached?.models ?? [];
      if (configured && (!cached || Date.now() >= cached.refreshAfter)) {
        try {
          const apiKey = resolveSecret(configured.apiKey);
          if (!apiKey) throw new Error('Provider credentials unavailable.');
          const remote = await refresh.refresh(context.providerId, configured.baseUrl,
            (signal) => new OpenAICompatibleProvider({ baseUrl: configured.baseUrl, apiKey, timeoutMs: 15_000 }).listModels(signal));
          models = mergeRefreshedModels(models, remote);
          metadata.set(context.providerId, { models, refreshAfter: Date.now() + MODEL_METADATA_TTL_MS });
        } catch {
          // Offline/unsupported discovery must not block a usable chat endpoint.
          metadata.set(context.providerId, { models, refreshAfter: Date.now() + 60_000 });
        }
      }
      return resolveEffectiveModelLimits(models.find((model) => model.id === context.model)
        ?? resolveModelMetadata({ discovered: { id: context.model } }), request);
    },
    resolve: (context: { providerId: string }) => {
      const providerConfig = config.provider.providers[context.providerId];
      if (!providerConfig) {
        throw new JojoCliError(
          `Provider is not configured: ${context.providerId}`,
          'PROVIDER_NOT_CONFIGURED',
          ExitCode.secretFailure
        );
      }
      const apiKey = resolveSecret(providerConfig.apiKey);
      if (!apiKey) {
        throw new JojoCliError(
          missingProviderSecretMessage(context.providerId, providerConfig.apiKey),
          'PROVIDER_SECRET_MISSING',
          ExitCode.secretFailure
        );
      }
      return new OpenAICompatibleProvider({ apiKey, baseUrl: providerConfig.baseUrl });
    }
  };
  const permissions: RuntimePermissionGate = {
    check: async (call, context) => {
      if (config.permissions.mode === 'yolo') return { decision: 'allow' };
      return {
        decision: 'ask',
        request: {
          requestId: randomUUID(),
          sessionId: context.sessionId,
          call,
          reason: config.permissions.mode === 'auto'
            ? 'This operation is not eligible for non-interactive automatic approval.'
            : 'Headless server approval is required.'
        }
      };
    }
  };
  const telemetry: TelemetrySink = {
    diagnostic(event, context) {
      logger.debug({
        event: `runtime.${event.type}`,
        sessionId: context.sessionId,
        laneId: context.laneId,
        runId: context.runId,
        ...(context.actor?.id ? { actorId: context.actor.id } : {})
      });
    }
  };
  return { providers, permissions, telemetry };
}

export function channelSecretResolver(environment: Record<string, string | undefined> = process.env): ChannelSecretResolver {
  return {
    async resolve(reference: string): Promise<string> {
      const match = /^secret:\/\/env\/([A-Z_][A-Z0-9_]*)$/u.exec(reference);
      if (!match) throw new Error(`unsupported_channel_secret_reference: ${reference}`);
      const value = environment[match[1]!];
      if (!value) throw new Error(`channel_secret_missing: ${match[1]}`);
      return value;
    }
  };
}

export function validateProviderSecret(config: EffectiveConfig): void {
  const selected = config.provider.providers[config.provider.defaultProviderId];
  if (!selected) {
    throw new JojoCliError(
      `Default provider is not configured: ${config.provider.defaultProviderId}`,
      'PROVIDER_NOT_CONFIGURED',
      ExitCode.secretFailure
    );
  }
  if (!resolveSecret(selected.apiKey)) {
    throw new JojoCliError(
      missingProviderSecretMessage(config.provider.defaultProviderId, selected.apiKey),
      'PROVIDER_SECRET_MISSING',
      ExitCode.secretFailure
    );
  }
}

function missingProviderSecretMessage(providerId: string, secret: EffectiveConfig['provider']['providers'][string]['apiKey']): string {
  const environmentName = secretEnvironmentName(secret);
  if (environmentName) {
    return `Secret for provider "${providerId}" is unavailable. Set it before starting Jojo:\n  export ${environmentName}='<your-api-key>'`;
  }
  return `Secret for provider "${providerId}" is unavailable. Configure provider.providers.${providerId}.apiKey.env or set a supported secret reference.`;
}
