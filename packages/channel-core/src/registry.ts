import type { ChannelAdapterFactory } from './internal-types.js';
import type { ChannelKind } from './types.js';

export class ChannelAdapterRegistry {
  private readonly factories = new Map<ChannelKind, ChannelAdapterFactory>();

  register(factory: ChannelAdapterFactory): void {
    if (this.factories.has(factory.kind)) throw new Error(`channel_adapter_already_registered: ${factory.kind}`);
    this.factories.set(factory.kind, factory);
  }

  get(kind: ChannelKind): ChannelAdapterFactory {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`channel_adapter_not_registered: ${kind}`);
    return factory;
  }

  list(): ChannelKind[] {
    return [...this.factories.keys()].sort();
  }
}
