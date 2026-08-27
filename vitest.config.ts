import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@desktop-agent/contracts/model': path.resolve('packages/contracts/src/model.ts'),
      '@desktop-agent/contracts/tools': path.resolve('packages/contracts/src/tools.ts'),
      '@desktop-agent/contracts/hooks': path.resolve('packages/contracts/src/hooks.ts'),
      '@desktop-agent/contracts/runtime': path.resolve('packages/contracts/src/runtime.ts'),
      '@desktop-agent/contracts/integrations': path.resolve('packages/contracts/src/integrations.ts'),
      '@desktop-agent/contracts/extension-api': path.resolve('packages/contracts/src/extension-api.ts'),
      '@desktop-agent/contracts': path.resolve('packages/contracts/src/index.ts'),
      '@desktop-agent/agent': path.resolve('packages/agent/src/index.ts'),
      '@desktop-agent/agent-runtime/testing': path.resolve('packages/agent-runtime/src/testing/index.ts'),
      '@desktop-agent/agent-runtime/spi': path.resolve('packages/agent-runtime/src/spi/index.ts'),
      '@desktop-agent/agent-runtime': path.resolve('packages/agent-runtime/src/index.ts'),
      '@desktop-agent/runtime-composition': path.resolve('packages/runtime-composition/src/index.ts'),
      '@desktop-agent/app-service': path.resolve('packages/app-service/src/index.ts'),
      '@desktop-agent/hooks': path.resolve('packages/hooks/src/index.ts'),
      '@desktop-agent/providers': path.resolve('packages/providers/src/index.ts'),
      '@desktop-agent/tools-node': path.resolve('packages/tools-node/src/index.ts'),
      '@desktop-agent/storage': path.resolve('packages/storage/src/index.ts')
      ,'@desktop-agent/memory': path.resolve('packages/memory/src/index.ts')
      ,'@desktop-agent/extensions': path.resolve('packages/extensions/src/index.ts')
      ,'@desktop-agent/orchestration': path.resolve('packages/orchestration/src/index.ts')
      ,'@desktop-agent/browser-automation/driver': path.resolve('packages/browser-automation/src/driver.ts')
      ,'@desktop-agent/browser-automation/recording': path.resolve('packages/browser-automation/src/recording.ts')
      ,'@desktop-agent/browser-automation/testing': path.resolve('packages/browser-automation/src/testing.ts')
      ,'@desktop-agent/browser-automation': path.resolve('packages/browser-automation/src/index.ts')
    }
  },
  test: { environment: 'node', include: ['packages/**/test/**/*.test.ts', 'apps/**/src/**/*.test.ts'] }
});
