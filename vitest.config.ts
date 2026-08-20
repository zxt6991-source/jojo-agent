import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@desktop-agent/contracts': path.resolve('packages/contracts/src/index.ts'),
      '@desktop-agent/agent': path.resolve('packages/agent/src/index.ts'),
      '@desktop-agent/agent-runtime': path.resolve('packages/agent-runtime/src/index.ts'),
      '@desktop-agent/providers': path.resolve('packages/providers/src/index.ts'),
      '@desktop-agent/tools-node': path.resolve('packages/tools-node/src/index.ts'),
      '@desktop-agent/storage': path.resolve('packages/storage/src/index.ts')
      ,'@desktop-agent/extensions': path.resolve('packages/extensions/src/index.ts')
    }
  },
  test: { environment: 'node', include: ['packages/**/test/**/*.test.ts', 'apps/**/src/**/*.test.ts'] }
});
