import { describe } from 'vitest';
import { MemoryAgentRuntimeStore } from '../src/memory-store.js';
import { runtimeStoreConformance } from './store-conformance.js';

describe('MemoryAgentRuntimeStore conformance', () => {
  runtimeStoreConformance((clock) => new MemoryAgentRuntimeStore(clock));
});
