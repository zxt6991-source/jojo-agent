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
      '@desktop-agent/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@desktop-agent/hooks': fileURLToPath(new URL('../../packages/hooks/src/index.ts', import.meta.url))
    }
  },
  build: {
    sourcemap: true,
    // Forge merges this with its own external array. Keep this value as an
    // array so mergeConfig does not nest a callback inside that array.
    rollupOptions: { external: electronNodeExternals }
  }
};
