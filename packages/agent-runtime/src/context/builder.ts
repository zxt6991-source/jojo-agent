import type { Message } from '@desktop-agent/contracts';
import type { AgentRuntimeStore } from '../store.js';
import { projectEntriesToMessages } from './projection.js';

export type BuildContextInput = {
  store: AgentRuntimeStore;
  leafId: string | null;
};

export type ModelContext = {
  messages: Message[];
  ambientContext: Array<{
    source: 'memory' | 'hook' | 'skill' | 'mcp';
    content: string;
    stable: boolean;
    estimatedTokens: number;
  }>;
};

export interface ContextBuilder {
  build(input: BuildContextInput): Promise<ModelContext>;
}

export class DefaultContextBuilder implements ContextBuilder {
  async build(input: BuildContextInput): Promise<ModelContext> {
    const entries = await input.store.readPath(input.leafId);
    const snapshots = entries.filter((entry) => entry.type === 'memory_snapshot');
    const snapshot = snapshots.at(-1);
    const recalls = entries.filter((entry) => entry.type === 'memory_recall');
    return {
      messages: projectEntriesToMessages(entries),
      ambientContext: [
        ...(snapshot?.content ? [{
          source: 'memory' as const,
          content: snapshot.content,
          stable: true,
          estimatedTokens: snapshot.estimatedTokens
        }] : []),
        ...recalls.filter((entry) => entry.content).map((entry) => ({
          source: 'memory' as const,
          content: entry.content,
          stable: false,
          estimatedTokens: entry.estimatedTokens
        }))
      ]
    };
  }
}
