import type { SecretBroker, SecretLease, SecretReference } from '@desktop-agent/contracts';

export class EnvironmentSecretBroker implements SecretBroker {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: SecretReference): Promise<SecretLease> {
    if (reference.provider !== 'env') throw Object.assign(new Error(`mcp_secret_unavailable: Unsupported secret provider ${reference.provider}.`), { code: 'mcp_secret_unavailable' });
    const value = this.environment[reference.key];
    if (!value) throw Object.assign(new Error(`mcp_secret_unavailable: Environment secret ${reference.key} is unavailable.`), { code: 'mcp_secret_unavailable' });
    return { value, dispose: () => undefined };
  }
}

export async function resolveMcpConfigValues(
  values: Record<string, string | { value: string } | { secretRef: SecretReference }> | undefined,
  broker: SecretBroker,
  purpose: string,
  sensitiveName: (name: string) => boolean
): Promise<{ values: Record<string, string>; dispose(): void }> {
  const resolved: Record<string, string> = {};
  const leases: SecretLease[] = [];
  try {
    for (const [name, configured] of Object.entries(values ?? {})) {
      if (typeof configured === 'string' || 'value' in configured) {
        if (sensitiveName(name)) throw Object.assign(new Error(`mcp_config_unsafe: Sensitive value ${name} must use secretRef.`), { code: 'mcp_config_unsafe' });
        resolved[name] = typeof configured === 'string' ? configured : configured.value;
      } else {
        const lease = await broker.resolve(configured.secretRef, { purpose });
        leases.push(lease);
        resolved[name] = lease.value;
      }
    }
    return { values: resolved, dispose: () => leases.splice(0).forEach((lease) => lease.dispose()) };
  } catch (error) {
    leases.forEach((lease) => lease.dispose());
    throw error;
  }
}
