import type { NetworkServer } from '@desktop-agent/server';
import type { SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import path from 'node:path';
import type { Logger } from 'pino';
import { resolveSecret } from '../config/redact.js';
import type { EffectiveConfig } from '../config/schema.js';
import { ExitCode, JojoCliError, errorMessage } from '../errors.js';
import { flushLogger } from '../logging/logger.js';
import { acquireInstanceLock } from './instance-lock.js';
import { runPreflight } from './preflight.js';
import { channelSecretResolver, createRuntimeDependencies } from './runtime-dependencies.js';
import { installShutdownHandlers } from './shutdown.js';

export async function serve(config: EffectiveConfig, logger: Logger): Promise<void> {
  logger.info({ event: 'server.starting', component: 'server' });
  const checks = await runPreflight(config, { requireProviderSecret: true });
  for (const check of checks) {
    if (check.status === 'warning') logger.warn({ event: check.name, detail: check.message });
  }
  const lock = await acquireInstanceLock(config);
  logger.info({ event: 'instance.lock.acquired', component: 'server', lockFile: config.paths.lockFile });
  let server: NetworkServer | undefined;
  let runtimeStore: SqliteAgentRuntimeStore | undefined;
  let runtimeStoreClosed = false;
  const closeResources = async () => {
    try {
      await server?.close();
    } finally {
      if (runtimeStore && !runtimeStoreClosed) {
        runtimeStoreClosed = true;
        runtimeStore.close();
      }
    }
  };
  const shutdown = installShutdownHandlers({
    close: closeResources,
    logger: logger.child({ component: 'server' }),
    timeoutMs: config.shutdown.timeoutMs
  });
  try {
    const [{ createNetworkServer }, { SqliteAgentRuntimeStore }] = await Promise.all([
      import('@desktop-agent/server'),
      import('@desktop-agent/storage')
    ]);
    const dependencies = createRuntimeDependencies(config, logger.child({ component: 'runtime' }));
    logger.info({ event: 'runtime.initializing', component: 'runtime' });
    runtimeStore = new SqliteAgentRuntimeStore(path.join(config.paths.dataDir, 'runtime.sqlite'));
    const serverToken = resolveSecret(config.server.token);
    server = await createNetworkServer({
      ...dependencies,
      store: runtimeStore,
      dataDir: config.paths.dataDir,
      instanceId: config.runtime.instanceId,
      scheduler: config.scheduler.enabled,
      server: {
        serverVersion: '0.1.0',
        models: modelList(config)
      },
      ...(config.channels.enabled ? {
        channels: {
          secrets: channelSecretResolver(),
          defaultProviderId: config.provider.defaultProviderId,
          defaultModel: config.provider.defaultModel
        }
      } : {}),
      http: {
        host: config.server.host,
        port: config.server.port,
        allowRemote: config.server.allowRemote,
        ...(serverToken ? { token: serverToken } : {}),
        logger: logger.child({ component: 'http' })
      }
    });
    logger.info({ event: 'runtime.ready', component: 'runtime' });
    const address = await server.listen();
    await lock.update(address);
    logger.info({ event: 'server.started', component: 'server', address });
    await shutdown.wait();
  } catch (error) {
    if (error instanceof JojoCliError) throw error;
    const message = errorMessage(error);
    const bindFailure = /(?:EADDRINUSE|EACCES|listen|bind)/iu.test(message);
    const storageFailure = /(?:sqlite|storage|database)/iu.test(message);
    throw new JojoCliError(
      message,
      bindFailure ? 'SERVER_BIND_FAILED' : storageFailure ? 'STORAGE_INIT_FAILED' : 'SERVER_START_FAILED',
      bindFailure ? ExitCode.bindFailure : storageFailure ? ExitCode.storageFailure : ExitCode.failure,
      undefined,
      { cause: error }
    );
  } finally {
    shutdown.dispose();
    await closeResources().catch(() => undefined);
    await lock.release();
    await flushLogger(logger).catch(() => undefined);
  }
}

function modelList(config: EffectiveConfig): Array<{ providerId: string; model: string; displayName?: string }> {
  return Object.entries(config.provider.providers).flatMap(([providerId, provider]) => {
    const models = provider.models ?? (providerId === config.provider.defaultProviderId ? [config.provider.defaultModel] : []);
    return models.map((model) => ({ providerId, model, ...(provider.name ? { displayName: `${provider.name} — ${model}` } : {}) }));
  });
}
