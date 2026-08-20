import { describe, expect, it } from 'vitest';
import { isElectronNodeExternal } from '../../vite.node.config';

describe('Electron Node Vite config', () => {
  it('keeps Electron and every node: builtin out of browser resolution', () => {
    expect(isElectronNodeExternal('electron')).toBe(true);
    expect(isElectronNodeExternal('node:fs')).toBe(true);
    expect(isElectronNodeExternal('node:sqlite')).toBe(true);
    expect(isElectronNodeExternal('@desktop-agent/storage')).toBe(false);
  });
});
