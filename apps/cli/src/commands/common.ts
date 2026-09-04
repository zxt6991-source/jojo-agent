import type { ConfigOverrides, EffectiveConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';

export type ConfigOptions = { config?: string; instanceId?: string };

export function loadCommandConfig(options: ConfigOptions, overrides: ConfigOverrides = {}): Promise<EffectiveConfig> {
  const runtime = {
    ...(overrides.runtime ?? {}),
    ...(options.instanceId ? { instanceId: options.instanceId } : {})
  };
  return loadConfig({
    ...(options.config ? { configPath: options.config } : {}),
    cliOverrides: { ...overrides, ...(Object.keys(runtime).length > 0 ? { runtime } : {}) }
  });
}
