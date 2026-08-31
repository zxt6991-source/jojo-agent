export type ChannelDeliveryFailureKind = 'retryable' | 'permanent' | 'unknown';

export class ChannelDeliveryError extends Error {
  constructor(message: string, readonly kind: ChannelDeliveryFailureKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChannelDeliveryError';
  }
}

export function channelDeliveryFailureKind(error: unknown): ChannelDeliveryFailureKind {
  return error instanceof ChannelDeliveryError ? error.kind : 'unknown';
}

const SECRET_KEY = /(?:token|secret|password|api[_-]?key|encrypt[_-]?key|credential)/iu;

export function assertChannelInstanceSecrets(input: {
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
}): void {
  const unsafe = findSecretKey(input.config);
  if (unsafe) throw new Error(`channel_plaintext_secret_forbidden: config.${unsafe}`);
  for (const [name, reference] of Object.entries(input.secretRefs)) {
    if (!reference.startsWith('secret://')) throw new Error(`channel_invalid_secret_reference: ${name}`);
  }
}

function findSecretKey(value: Record<string, unknown>, prefix = ''): string | undefined {
  for (const [key, child] of Object.entries(value)) {
    const propertyPath = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY.test(key) && child !== undefined && child !== null && child !== '') return propertyPath;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const nested = findSecretKey(child as Record<string, unknown>, propertyPath);
      if (nested) return nested;
    }
  }
  return undefined;
}
