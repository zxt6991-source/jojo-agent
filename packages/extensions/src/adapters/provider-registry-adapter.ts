import type { ContributionOwner, Disposable, ProviderContribution } from '@desktop-agent/contracts';
import type { ProviderRegistry } from '@desktop-agent/providers';

function providerId(owner: ContributionOwner, localId: string): string {
  return owner.source === 'builtin' ? localId : `${owner.id}:${localId}`;
}

export class ProviderRegistryAdapter {
  constructor(private readonly registry: ProviderRegistry) {}

  get version(): number { return this.registry.version; }

  register(owner: ContributionOwner, contribution: ProviderContribution): Disposable {
    return this.registry.register({ ...contribution, id: providerId(owner, contribution.id) });
  }
}
