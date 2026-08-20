import { describe, expect, it, vi } from 'vitest';
import { TurnTaskRegistry } from './turn-task-registry';

describe('TurnTaskRegistry', () => {
  it('ignores a duplicate launch without disturbing the active turn', async () => {
    let finish: (() => void) | undefined;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    const registry = new TurnTaskRegistry();
    const first = vi.fn(() => active);
    const duplicate = vi.fn(async () => undefined);

    expect(registry.launch('session-1', first)).toBe(true);
    expect(registry.launch('session-1', duplicate)).toBe(false);
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();

    finish?.();
    await registry.wait('session-1');
    await Promise.resolve();

    expect(registry.launch('session-1', duplicate)).toBe(true);
    await registry.wait('session-1');
    expect(duplicate).toHaveBeenCalledOnce();
  });
});
