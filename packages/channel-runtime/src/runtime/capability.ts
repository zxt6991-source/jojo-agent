import type { RuntimeCapability, RuntimeEnvironmentBuilder } from '@desktop-agent/runtime-composition';
import type { ChannelService } from '../service.js';
import { createChannelTools } from './tools.js';

export class ChannelRuntimeCapability implements RuntimeCapability {
  constructor(private readonly service: ChannelService) {}
  contribute(builder: RuntimeEnvironmentBuilder): void {
    builder.addTools(() => createChannelTools(this.service));
  }
}
