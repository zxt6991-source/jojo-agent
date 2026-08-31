import type { UserConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export const electronNodeExternals: Array<string | RegExp> = ['electron', /^node:/u];

export function isElectronNodeExternal(id: string): boolean {
  return electronNodeExternals.some((external) => typeof external === 'string'
    ? external === id
    : external.test(id));
}

export const electronNodeConfig: UserConfig = {
  resolve: {
    alias: {
      '@desktop-agent/agent-runtime/spi': fileURLToPath(new URL('../../packages/agent-runtime/src/spi/index.ts', import.meta.url)),
      '@desktop-agent/agent-runtime': fileURLToPath(new URL('../../packages/agent-runtime/src/index.ts', import.meta.url)),
      '@desktop-agent/browser-automation': fileURLToPath(new URL('../../packages/browser-automation/src/index.ts', import.meta.url)),
      '@desktop-agent/channel-core/testing': fileURLToPath(new URL('../../packages/channel-core/src/testing.ts', import.meta.url)),
      '@desktop-agent/channel-adapters': fileURLToPath(new URL('../../packages/channel-adapters/src/index.ts', import.meta.url)),
      '@desktop-agent/channel-core': fileURLToPath(new URL('../../packages/channel-core/src/index.ts', import.meta.url)),
      '@desktop-agent/channel-runtime': fileURLToPath(new URL('../../packages/channel-runtime/src/index.ts', import.meta.url)),
      '@desktop-agent/contracts/runtime': fileURLToPath(new URL('../../packages/contracts/src/runtime.ts', import.meta.url)),
      '@desktop-agent/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@desktop-agent/hooks': fileURLToPath(new URL('../../packages/hooks/src/index.ts', import.meta.url)),
      '@desktop-agent/memory': fileURLToPath(new URL('../../packages/memory/src/index.ts', import.meta.url)),
      '@desktop-agent/runtime-composition': fileURLToPath(new URL('../../packages/runtime-composition/src/index.ts', import.meta.url)),
      '@desktop-agent/scheduler': fileURLToPath(new URL('../../packages/scheduler/src/index.ts', import.meta.url))
    }
  },
  build: {
    sourcemap: true,
    // Forge merges this with its own external array. Keep this value as an
    // array so mergeConfig does not nest a callback inside that array.
    rollupOptions: { external: electronNodeExternals }
  }
};
