import type { UserConfig } from 'vite';

export function isElectronNodeExternal(id: string): boolean {
  return id === 'electron' || id.startsWith('node:');
}

export const electronNodeConfig: UserConfig = {
  build: {
    sourcemap: true,
    rollupOptions: { external: isElectronNodeExternal }
  }
};
