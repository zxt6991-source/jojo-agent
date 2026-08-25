import { mergeConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { electronNodeConfig, isElectronNodeExternal } from '../../vite.node.config';

describe('Electron Node Vite config', () => {
  it('keeps Electron and every node: builtin out of browser resolution', () => {
    expect(isElectronNodeExternal('electron')).toBe(true);
    expect(isElectronNodeExternal('node:fs')).toBe(true);
    expect(isElectronNodeExternal('node:sqlite')).toBe(true);
    expect(isElectronNodeExternal('@desktop-agent/storage')).toBe(false);
  });

  it('still externalizes node:sqlite after Forge merges its external array', () => {
    const merged = mergeConfig({
      build: { rollupOptions: { external: ['electron/main', 'node:fs'] } }
    }, electronNodeConfig);
    const external = merged.build?.rollupOptions?.external;
    expect(Array.isArray(external)).toBe(true);
    const entries = external as Array<string | RegExp>;
    expect(entries.every((entry) => typeof entry === 'string' || entry instanceof RegExp)).toBe(true);
    expect(entries.some((entry) => typeof entry === 'string'
      ? entry === 'node:sqlite'
      : entry.test('node:sqlite'))).toBe(true);
  });

  it('resolves the hooks workspace package without requiring a stale node_modules link', () => {
    const alias = electronNodeConfig.resolve?.alias;
    expect(alias).toMatchObject({
      '@desktop-agent/browser-automation': expect.stringContaining('/packages/browser-automation/src/index.ts'),
      '@desktop-agent/contracts': expect.stringContaining('/packages/contracts/src/index.ts'),
      '@desktop-agent/hooks': expect.stringContaining('/packages/hooks/src/index.ts'),
      '@desktop-agent/memory': expect.stringContaining('/packages/memory/src/index.ts')
    });
  });
});
