import type { Message } from '@desktop-agent/contracts';
import type { AgentRuntimeStore } from '../store.js';
import { projectEntriesToMessages } from './projection.js';

export type BuildContextInput = {
  store: AgentRuntimeStore;
  leafId: string | null;
};

export type ModelContext = {
  messages: Message[];
};

export interface ContextBuilder {
  build(input: BuildContextInput): Promise<ModelContext>;
}

export class DefaultContextBuilder implements ContextBuilder {
  async build(input: BuildContextInput): Promise<ModelContext> {
    return { messages: projectEntriesToMessages(await input.store.readPath(input.leafId)) };
  }
}
