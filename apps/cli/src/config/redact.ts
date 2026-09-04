import type { EffectiveConfig, Secret } from './schema.js';

export const REDACTED = '[REDACTED]';

export function redactConfig(config: EffectiveConfig): Record<string, unknown> {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  redactObject(copy);
  return copy;
}

export function resolveSecret(secret: Secret | undefined, environment: Record<string, string | undefined> = process.env): string | undefined {
  if (secret === undefined) return undefined;
  if (typeof secret === 'string') return secret;
  if ('literal' in secret) return secret.literal;
  return environment[secret.env];
}

export function secretEnvironmentName(secret: Secret | undefined): string | undefined {
  return secret && typeof secret === 'object' && 'env' in secret ? secret.env : undefined;
}

function redactObject(value: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    if (/(?:authorization|cookie|token|apiKey|secret|password|encryptKey)$/iu.test(key)) {
      value[key] = REDACTED;
    } else if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object') redactObject(item as Record<string, unknown>);
      } else {
        redactObject(child as Record<string, unknown>);
      }
    }
  }
}
