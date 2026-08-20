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
});
