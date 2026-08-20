import { describe } from 'vitest';
import { MemoryAgentRuntimeStore } from '../src/index.js';
import { runtimeStoreConformance } from './store-conformance.js';

describe('MemoryAgentRuntimeStore conformance', () => {
  runtimeStoreConformance((clock) => new MemoryAgentRuntimeStore(clock));
});
